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

// Updated imports
import { EventEmitter } from "events";
import { config } from "./config";
import { logger } from "./logger";
import { saveResult } from "./persistence";
import { StellarPaymentTool } from "./tools/StellarPaymentTool";
import { SorobanInvokeTool } from "./tools/SorobanInvokeTool";
import { X402PaymentTool, X402Challenge } from "./tools/X402PaymentTool";
import { AccountInfoTool } from "./tools/AccountInfoTool";
import { TrustlineTool } from "./tools/TrustlineTool";
import { MultiSigPaymentTool } from "./tools/MultiSigPaymentTool";
import { BatchPaymentTool } from "./tools/BatchPaymentTool";
import { horizonServer } from "./rpc_client";
import { createLogger, generateCorrelationId } from "./utils/logger";
import { SpendingTracker, assetKey } from "./spending_tracker";

// ── Module-level singleton tracker shared across all agent instances ──────────
// NOTE: For process-wide spending enforcement, the tracker is a module singleton.
// Tests that need isolation should call _resetSpendingTrackerForTests().
const spendingTracker = new SpendingTracker();

/**
 * Reset the module-level SpendingTracker singleton.
 * FOR TESTING ONLY — clears in-memory entries between tests.
 * @internal
 */
export function _resetSpendingTrackerForTests(): void {
  spendingTracker._resetForTests();
}

const log = createLogger("orchestrator");

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskType =
  | "stellar_payment"
  | "soroban_invoke"
  | "x402_respond"
  | "account_info"
  | "change_trust"
  | "multisig_payment"
  | "batch_payment";


export interface AgentTask {
  type: TaskType;
  payload: unknown;
}

export interface AgentResultData {
  txHash?: string;
  ledger?: number;
  simulationResult?: unknown;
  protocol?: string;
  network?: string;
  nonce?: string;
  payer?: string;
  signedAt?: string;
}

export interface AgentResult {
  success: boolean;
  taskType: TaskType;
  data?: AgentResultData;
  error?: string;
}

// ─── Payload sanitisation ─────────────────────────────────────────────────────

const SECRET_KEY_RE = /^(?<prefix>.*?["':\s]?)(?<secret>S[ A-Z2-7]{55})(?<suffix>["'\s]?.*)$/i;

function redactSecretString(value: string): string {
  return value.replace(SECRET_KEY_RE, "$<prefix>[REDACTED]$<suffix>");
}

function sanitizePayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object") return payload;
  if (Array.isArray(payload)) return payload.map(sanitizePayload);

  const sanitized: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(payload as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (/secret|key|seed|mnemonic|private/i.test(key)) continue;
    sanitized[key] = rawValue;
  }
  return sanitized;
}

// ─── Spending limit guard ─────────────────────────────────────────────────────

/**
 * Atomically reserve a spending amount for the given asset.
 *
 * Uses BigInt stroop arithmetic (no parseFloat).
 * Per-asset limits are resolved from config.SPENDING_LIMITS_MAP.
 * Unknown assets are denied unless SPENDING_LIMITS_ALLOW_UNKNOWN is true.
 *
 * @param amount      - The amount string from the task payload.
 * @param assetCode   - Asset code (e.g. "XLM", "USDC").
 * @param assetIssuer - G-address issuer; absent / empty for native XLM.
 * @returns           A reservation id — pass to commitSpend() or rollbackSpend().
 * @throws            If the amount is malformed, asset is denied, or limit exceeded.
 */
function reserveSpend(amount: unknown, assetCode?: unknown, assetIssuer?: unknown): string {
  if (typeof amount !== "string") {
    // Let the tool's own Zod schema surface a better error; do not block here.
    return "";
  }
  const code    = typeof assetCode   === "string" ? assetCode   : config.X402_ASSET_CODE;
  const issuer  = typeof assetIssuer === "string" ? assetIssuer : config.X402_ASSET_ISSUER;
  const key     = assetKey(code, issuer);
  return spendingTracker.reserve(amount, key);
}

function commitSpend(reservationId: string): void {
  if (reservationId) spendingTracker.commit(reservationId);
}

function rollbackSpend(reservationId: string): void {
  if (reservationId) spendingTracker.rollback(reservationId);
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export class PayFiAgent extends EventEmitter {
  private paymentTool: StellarPaymentTool;
  private sorobanTool: SorobanInvokeTool;
  private x402Tool: X402PaymentTool;
  private accountInfoTool: AccountInfoTool;
  private trustlineTool: TrustlineTool;
  private multiSigTool: MultiSigPaymentTool;
  private batchPaymentTool: BatchPaymentTool;


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
    this.x402Tool    = new X402PaymentTool(config.agentKeypair().secret());
    this.accountInfoTool = new AccountInfoTool();
    this.trustlineTool = new TrustlineTool(config.agentKeypair().secret());
    this.multiSigTool = new MultiSigPaymentTool(config.agentKeypair().secret());
    this.batchPaymentTool = new BatchPaymentTool(config.agentKeypair().secret());


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

    // reservationId is non-empty only for payment tasks that were reserved
    let reservationId = "";

    try {
      let data: AgentResultData | unknown;

      switch (task.type) {
        case "stellar_payment": {
          const p = task.payload as Record<string, unknown>;
          // Atomically reserve spend — throws if limit exceeded or asset denied
          reservationId = reserveSpend(p?.amount, p?.assetCode, p?.assetIssuer);
          data = await this.paymentTool.execute(task.payload);
          commitSpend(reservationId);
          break;
        }

        case "soroban_invoke": {
          data = await this.sorobanTool.execute(task.payload);
          break;
        }

        case "x402_respond": {
          const p = task.payload as Record<string, unknown>;
          // Atomically reserve spend — throws if limit exceeded or asset denied
          reservationId = reserveSpend(p?.amount, p?.assetCode, p?.assetIssuer);
          data = await this.x402Tool.respond(task.payload);
          commitSpend(reservationId);
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

        case "batch_payment":
          data = await this.batchPaymentTool.execute(task.payload);
          break;

        default:
          throw new Error(`Unknown task type: ${(task as AgentTask).type}`);
      }

      logger.info("Task completed", { taskType: task.type });
      const _data = data as AgentResultData | undefined;
      const result: AgentResult = _data !== undefined
        ? { success: true, taskType: task.type, data: _data }
        : { success: true, taskType: task.type };
      this.emit("task:complete", result);
      saveResult({ ...result, timestamp: new Date().toISOString() });
      return result;
    } catch (err) {
      // Roll back the reservation so the failed payment is not counted
      rollbackSpend(reservationId);

      const message = err instanceof Error ? err.message : String(err);
      const safe = redactSecretString(message);
      const sanitized = sanitizePayload(task.payload);
      logger.error("Task failed", { taskType: task.type, error: safe, sanitizedPayload: sanitized });
      const result: AgentResult = { success: false, taskType: task.type, error: safe };
      this.emit("task:failed", result);
      return result;
    } finally {
      this.activeTasks--;
    }
  }
}
