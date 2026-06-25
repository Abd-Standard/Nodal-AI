/**
 * backend/agent.ts
 *
 * Core PayFi Agent orchestrator.
 *
 * Config usage pattern:
 *   - All network/identity values come from the validated `config` singleton.
 *   - Tools that need the Keypair call `config.agentKeypair()` explicitly —
 *     the secret never lives on the config object itself.
 *   - The spending limit is enforced here before delegating to tools.
 */

import { EventEmitter } from "events";
import { config, MAINNET_SPENDING_CAP } from "./config";
import { logger } from "./logger";
import { StellarPaymentTool } from "./tools/StellarPaymentTool";
import { SorobanInvokeTool } from "./tools/SorobanInvokeTool";
import { X402PaymentTool, X402Challenge } from "./tools/X402PaymentTool";
import { AccountInfoTool } from "./tools/AccountInfoTool";
import { TrustlineTool } from "./tools/TrustlineTool";
import { MultiSigPaymentTool } from "./tools/MultiSigPaymentTool";
import { horizonServer } from "./rpc_client";
import { createLogger, generateCorrelationId } from "./utils/logger";

const log = createLogger("orchestrator");

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskType =
  | "stellar_payment"
  | "soroban_invoke"
  | "x402_respond"
  | "account_info"
  | "change_trust"
  | "multisig_payment";

export interface AgentTask {
  type: TaskType;
  payload: unknown;
}

export interface AgentResult {
  success: boolean;
  taskType: TaskType;
  data?: unknown;
  error?: string;
}

// ─── Spending limit guard ─────────────────────────────────────────────────────

/**
 * Check that a payment amount does not exceed the configured spending limit.
 * Called before delegating to StellarPaymentTool or X402PaymentTool.
 */
function assertWithinSpendingLimit(amount: unknown): void {
  if (typeof amount !== "string") return; // let the tool's own schema catch this
  const parsed = parseFloat(amount);
  const limit  = parseFloat(config.AGENT_SPENDING_LIMIT);
  if (!isNaN(parsed) && parsed > limit) {
    throw new Error(
      `Payment amount ${amount} ${config.X402_ASSET_CODE} exceeds ` +
      `AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
    );
  }
  if (!isNaN(parsed) && config.STELLAR_NETWORK === "mainnet" && parsed > MAINNET_SPENDING_CAP) {
    throw new Error(
      `Payment amount ${amount} ${config.X402_ASSET_CODE} exceeds ` +
      `mainnet spending cap of ${MAINNET_SPENDING_CAP}`
    );
  }
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export class PayFiAgent extends EventEmitter {
  private paymentTool: StellarPaymentTool;
  private sorobanTool: SorobanInvokeTool;
  private sorobanQueryTool: SorobanQueryTool;
  private x402Tool: X402PaymentTool;
  private accountInfoTool: AccountInfoTool;
  private trustlineTool: TrustlineTool;
  private multiSigTool: MultiSigPaymentTool;

  private activeTasks = 0;
  private isDraining = false;
  private _streamStop: (() => void) | null = null;

  // Bound handler references kept so destroy() can call .off() with the exact same function
  // reference — EventEmitter requires identity equality for removal.
  private readonly _boundHandlers = new Map<string, (...args: unknown[]) => void>();

  constructor() {
    super();

    // config.agentKeypair().secret() is the canonical way to obtain the signing secret.
    // Direct access to config.AGENT_SECRET_KEY is intentionally blocked by the AgentConfig
    // type (Omit<RawEnv, "AGENT_SECRET_KEY">); using agentKeypair() makes the access explicit.
    this.paymentTool = new StellarPaymentTool(config.agentKeypair().secret());
    this.sorobanTool = new SorobanInvokeTool(config.agentKeypair().secret());
    this.sorobanQueryTool = new SorobanQueryTool(config.agentKeypair().secret());
    this.x402Tool    = new X402PaymentTool(config.agentKeypair().secret());
    this.accountInfoTool = new AccountInfoTool();
    this.trustlineTool = new TrustlineTool(config.agentKeypair().secret());
    this.multiSigTool = new MultiSigPaymentTool(config.agentKeypair().secret());

    // ── Register event listeners — every registration is mirrored in destroy() ──
    const onError = (err: Error) => {
      const safe = err.message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
      logger.error("Unhandled agent error", { error: safe });
    };
    const onTaskComplete = (result: AgentResult) => {
      logger.info("Task complete", { taskType: result.taskType });
    };
    const onTaskFailed = (result: AgentResult) => {
      logger.warn("Task failed", { taskType: result.taskType, error: result.error });
    };

    this.on("error", onError);
    this.on("task:complete", onTaskComplete);
    this.on("task:failed", onTaskFailed);

    this._boundHandlers.set("error", onError as (...args: unknown[]) => void);
    this._boundHandlers.set("task:complete", onTaskComplete as (...args: unknown[]) => void);
    this._boundHandlers.set("task:failed", onTaskFailed as (...args: unknown[]) => void);

    // Log only safe fields — public key is derived, not the secret
    logger.info("PayFiAgent initialised", {
      network: config.STELLAR_NETWORK,
      horizon: config.HORIZON_URL,
      soroban: config.SOROBAN_RPC_URL,
      agentPubkey: config.AGENT_PUBLIC_KEY,
      spendingLimit: config.AGENT_SPENDING_LIMIT,
      assetCode: config.X402_ASSET_CODE,
    });
  }

  /**
   * Start polling the Horizon payment stream for incoming x402 challenges.
   * Calls onChallenge for each payment whose memo starts with "x402:".
   */
  startListening(resourceUrl: string, onChallenge: (challenge: X402Challenge) => void): void {
    if (this._streamStop) return; // already listening

    const closeStream = horizonServer
      .payments()
      .forAccount(config.AGENT_PUBLIC_KEY)
      .stream({
        onmessage: (payment: any) => {
          const memo: string = payment.memo ?? "";
          if (!memo.startsWith("x402:")) return;
          try {
            const challenge: X402Challenge = JSON.parse(
              Buffer.from(memo.slice(5), "base64").toString("utf8")
            );
            onChallenge(challenge);
          } catch {
            // Malformed memo — ignore
          }
        },
        onerror: (event: MessageEvent) => {
          logger.warn("Payment stream error", { error: String(event) });
        },
      });

    this._streamStop = closeStream as unknown as () => void;
    logger.info("Payment stream started", { resourceUrl });
  }

  /** Stop the active Horizon payment stream subscription. */
  stopListening(): void {
    if (this._streamStop) {
      this._streamStop();
      this._streamStop = null;
      logger.info("Payment stream stopped");
    }
  }

  /**
   * Detach all registered event listeners and release internal resources.
   *
   * Must be called by the lifecycle manager when an agent instance is
   * decommissioned or stopped. Failure to call destroy() prevents the garbage
   * collector from reclaiming this instance because EventEmitter holds a strong
   * reference to every registered callback closure.
   *
   * Usage:
   *   const agent = new PayFiAgent();
   *   // ... use agent ...
   *   agent.destroy(); // call when decommissioning
   */
  destroy(): void {
    this.stopListening();
    for (const [event, handler] of this._boundHandlers) {
      this.off(event, handler);
    }
    this._boundHandlers.clear();
    // Remove any listeners added externally after construction
    this.removeAllListeners();
    logger.info("Agent destroyed — all event listeners removed");
  }

  drain(): void {
    this.isDraining = true;
    logger.info("Agent draining — rejecting new tasks");
  }

  async waitForPendingTasks(): Promise<void> {
    if (this.activeTasks === 0) return;
    logger.info("Waiting for pending tasks to finish", { activeTasks: this.activeTasks });
    return new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this.activeTasks === 0) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Execute an ordered list of tasks sequentially, stopping on the first failure.
   *
   * Each task is dispatched through `run()` so spending-limit guards and tool
   * routing behave identically to single-task execution. Tasks are never
   * pre-validated as a batch — the limit is checked per-task at dispatch time.
   *
   * @param tasks - Ordered list of tasks to execute.
   * @returns An array of results. The array length equals the index of the first
   *   failed task plus one — subsequent tasks are never executed or returned.
   */
  async runSequence(tasks: AgentTask[]): Promise<AgentResult[]> {
    const results: AgentResult[] = [];
    for (const task of tasks) {
      const result = await this.run(task);
      results.push(result);
      if (!result.success) break;
    }
    return results;
  }

  /** Dispatch a task to the correct tool */
  async run(task: AgentTask): Promise<AgentResult> {
    if (this.isDraining) {
      return {
        success: false,
        taskType: task.type,
        error: "Agent is shutting down — task rejected",
      };
    }

    this.activeTasks++;
    logger.info("Running task", { taskType: task.type });
    try {
      let data: unknown;

      switch (task.type) {
        case "stellar_payment": {
          const p = task.payload as Record<string, unknown>;
          assertWithinSpendingLimit(p?.amount);
          data = await this.paymentTool.execute(task.payload);
          break;
        }

        case "soroban_invoke":
          data = await this.sorobanTool.execute(task.payload);
          break;

        case "soroban_query":
          data = await this.sorobanQueryTool.query(task.payload);
          break;

        case "x402_respond": {
          const p = task.payload as Record<string, unknown>;
          assertWithinSpendingLimit(p?.amount);
          data = await this.x402Tool.respond(task.payload);
          break;
        }

        case "account_info":
          data = await this.accountInfoTool.fetch();
          break;

        case "change_trust":
          data = await this.trustlineTool.execute(task.payload);
          break;

        case "multisig_payment":
          data = await this.multiSigTool.execute(task.payload);
          break;

        default:
          throw new Error(`Unknown task type: ${(task as AgentTask).type}`);
      }

      logger.info("Task completed", { taskType: task.type });
      const result: AgentResult = { success: true, taskType: task.type, data };
      this.emit("task:complete", result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Redact anything that looks like a secret key before logging
      const safe = message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
      logger.error("Task failed", { taskType: task.type, error: safe });
      const result: AgentResult = { success: false, taskType: task.type, error: safe };
      this.emit("task:failed", result);
      return result;
    } finally {
      this.activeTasks--;
    }
  }
}
