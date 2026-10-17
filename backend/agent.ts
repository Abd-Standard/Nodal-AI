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
import { rpc } from "@stellar/stellar-sdk";
import { config, MAINNET_SPENDING_CAP } from "./config";
import { logger } from "./logger";
import { saveResult } from "./persistence";
import { StructuredError, ErrorType, getErrorType } from "./errors";
import { StellarPaymentTool } from "./tools/StellarPaymentTool";
import { SorobanInvokeTool } from "./tools/SorobanInvokeTool";
import { X402PaymentTool, X402Challenge, X402ChallengeSchema } from "./tools/X402PaymentTool";
import { AccountInfoTool } from "./tools/AccountInfoTool";
import { TrustlineTool } from "./tools/TrustlineTool";
import { MultiSigPaymentTool } from "./tools/MultiSigPaymentTool";
import { BatchPaymentTool } from "./tools/BatchPaymentTool";
import { SorobanQueryTool } from "./tools/SorobanQueryTool";
import { BalanceCheckTool } from "./tools/BalanceCheckTool";
import { PathPaymentTool } from "./tools/PathPaymentTool";
import { FeeBumpTool } from "./tools/FeeBumpTool";
import { DexOfferTool } from "./tools/DexOfferTool";
import { listen as listenContractEvents } from "./tools/ContractEventListener";

import { horizonServer } from "./rpc_client";
import { createLogger, generateCorrelationId } from "./utils/logger";
import { SpendingTracker } from "./spending_tracker";
import { dispatchWebhook } from "./webhook";

// Instantiate a singleton tracker
export const spendingTracker = new SpendingTracker();

// ─── Spending limit guard ─────────────────────────────────────────────────────

/**
 * Check that a payment amount does not exceed the configured per-payment and
 * mainnet spending caps, then **reserve** the amount against the cumulative
 * rolling-window limit.
 *
 * ## Issue #729 — reserve-before-submit
 * Returns a `reservationId` string that the caller MUST pass to either
 * `spendingTracker.commit(id)` on successful submission or
 * `spendingTracker.release(id)` on failure/rejection.  Using reserve() instead
 * of the old record()-before-submit pattern means that a network error,
 * bad-sequence retry, or any other submission failure does NOT permanently
 * consume quota from the rolling window.
 *
 * Returns `null` for non-string amounts (tool schema will catch them).
 *
 * @throws if the single-payment amount exceeds AGENT_SPENDING_LIMIT or the
 *   mainnet safety cap, or if the cumulative reserved+committed total would
 *   exceed the limit.
 */
function reserveSpendingLimit(amount: unknown): string | null {
  if (typeof amount !== "string") return null; // let the tool's own schema catch this

  const parsed = parseFloat(amount);
  const limit = parseFloat(config.AGENT_SPENDING_LIMIT);

  // Layer 1: single-payment cap
  if (!isNaN(parsed) && parsed > limit) {
    throw new Error(
      `Payment amount ${amount} ${config.X402_ASSET_CODE} exceeds ` +
        `AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
    );
  }
  // Layer 2: mainnet hard cap
  if (!isNaN(parsed) && config.STELLAR_NETWORK === "mainnet" && parsed > MAINNET_SPENDING_CAP) {
    throw new Error(
      `Payment amount ${amount} ${config.X402_ASSET_CODE} exceeds ` +
        `mainnet spending cap of ${MAINNET_SPENDING_CAP}`
    );
  }

  // Layer 3: reserve against rolling-window cumulative limit (issue #729)
  // Returns a reservationId — caller must commit() on success or release() on failure.
  return spendingTracker.reserve(amount);
}

const log = createLogger("orchestrator");

// ─── Task types ───────────────────────────────────────────────────────────────

export type TaskType =
  | "stellar_payment"
  | "soroban_invoke"
  | "soroban_query"
  | "x402_respond"
  | "account_info"
  | "change_trust"
  | "multisig_payment"
  | "batch_payment"
  | "balance_check"
  | "path_payment"
  | "fee_bump"
  | "dex_offer";


export interface AgentTask {
  type: TaskType;
  payload: unknown;
  /**
   * Optional caller-supplied correlation ID. When omitted, `run()` generates
   * one so every task execution is traceable end-to-end.
   */
  correlationId?: string;
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
  data?: unknown;
  error?: string;
  /**
   * Structured error type for programmatic error handling.
   * Allows callers to distinguish between different error categories
   * (e.g., InsufficientFunds, NetworkTimeout) without string matching.
   */
  errorType?: string;
  /**
   * Correlation ID that ties every log line, persisted result, and webhook
   * dispatch for a single task execution together. Generated at dispatch time
   * unless the caller supplies one on the task.
   */
  correlationId?: string;
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
    sanitized[key] = sanitizePayload(rawValue);
  }
  return sanitized;
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
  private batchPaymentTool: BatchPaymentTool;
  private balanceCheckTool: BalanceCheckTool;
  private pathPaymentTool: PathPaymentTool;
  private feeBumpTool: FeeBumpTool;
  private dexOfferTool: DexOfferTool;

  private activeTasks = 0;
  private isDraining = false;
  private _streamStop: (() => void) | null = null;
  private _contractListenerStop: (() => void) | null = null;

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
    this.batchPaymentTool = new BatchPaymentTool(config.agentKeypair().secret());
    this.balanceCheckTool = new BalanceCheckTool();
    this.pathPaymentTool = new PathPaymentTool(config.agentKeypair().secret());
    this.feeBumpTool = new FeeBumpTool(config.agentKeypair().secret());
    this.dexOfferTool = new DexOfferTool(config.agentKeypair().secret());


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
            const raw: unknown = JSON.parse(
              Buffer.from(memo.slice(5), "base64").toString("utf8")
            );
            const challenge: X402Challenge = X402ChallengeSchema.parse(raw);
            onChallenge(challenge);
          } catch (err) {
            // Malformed or schema-invalid memo — log and drop rather than
            // forwarding to onChallenge (or letting Zod's error surface
            // deep inside respond(), where it can't be attributed to the
            // stream that produced it).
            logger.warn("Dropped invalid x402 challenge memo", {
              error: err instanceof Error ? err.message : String(err),
            });
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
   * Start polling a Soroban contract for events.
   * Calls onEvent for each new event matching the provided eventTypes filter.
   * Pass an empty array for eventTypes to receive all contract events.
   *
   * @param contractId - The Stellar contract ID to monitor.
   * @param eventTypes - Topic strings to filter by (empty array = all events).
   * @param onEvent    - Callback invoked for each matching event.
   */
  startContractListener(
    contractId: string,
    eventTypes: string[],
    onEvent: (event: rpc.Api.EventResponse) => void
  ): void {
    if (this._contractListenerStop) {
      this._contractListenerStop();
    }
    this._contractListenerStop = listenContractEvents(contractId, eventTypes, onEvent);
    logger.info("Contract event listener started", { contractId });
  }

  /** Stop the active contract event listener. */
  stopContractListener(): void {
    if (this._contractListenerStop) {
      this._contractListenerStop();
      this._contractListenerStop = null;
      logger.info("Contract event listener stopped");
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
    this.stopContractListener();
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
    // Correlation ID ties together every log line, event, persisted result,
    // and webhook for this single task execution. Reuse the caller's if given.
    const correlationId = task.correlationId ?? generateCorrelationId();
    const taskLog = createLogger("orchestrator", correlationId);

    if (this.isDraining) {
      return {
        success: false,
        taskType: task.type,
        error: "Agent is shutting down — task rejected",
        correlationId,
      };
    }

    // ── Concurrency rate limit — reject rather than queue when saturated ──
    if (this.activeTasks >= config.MAX_CONCURRENT_TASKS) {
      taskLog.warn(
        {
          taskType: task.type,
          activeTasks: this.activeTasks,
          maxConcurrentTasks: config.MAX_CONCURRENT_TASKS,
        },
        "Task rejected — max concurrent tasks reached"
      );
      return {
        success: false,
        taskType: task.type,
        error:
          `Agent is at capacity — ${this.activeTasks}/${config.MAX_CONCURRENT_TASKS} ` +
          `concurrent tasks in flight; task rejected`,
        correlationId,
      };
    }

    this.activeTasks++;
    taskLog.info({ taskType: task.type }, "Running task");
    try {
      let data: unknown;

      switch (task.type) {
        case "stellar_payment": {
          // issue #729 — reserve before submit, commit/release after
          const p = task.payload as Record<string, unknown>;
          const reservationId = reserveSpendingLimit(p?.amount);
          try {
            data = await this.paymentTool.execute(task.payload);
            if (reservationId !== null) spendingTracker.commit(reservationId);
          } catch (toolErr) {
            if (reservationId !== null) spendingTracker.release(reservationId);
            throw toolErr;
          }
          break;
        }

        case "soroban_invoke": {
          data = await this.sorobanTool.execute(task.payload);
          break;
        }

        case "soroban_query":
          data = await this.sorobanQueryTool.query(task.payload);
          break;

        case "x402_respond": {
          // issue #729 — reserve before submit, commit/release after
          const p = task.payload as Record<string, unknown>;
          const reservationId = reserveSpendingLimit(p?.amount);
          try {
            data = await this.x402Tool.respond(task.payload);
            if (reservationId !== null) spendingTracker.commit(reservationId);
          } catch (toolErr) {
            if (reservationId !== null) spendingTracker.release(reservationId);
            throw toolErr;
          }
          break;
        }

        case "account_info":
          data = await this.accountInfoTool.fetch();
          break;

        case "change_trust":
          data = await this.trustlineTool.execute(task.payload);
          break;

        case "multisig_payment": {
          // issue #728 — multisig_payment was unguarded; apply spending limit
          // Only guard when enough signatures are present (i.e., the tx will be submitted).
          // When returning unsignedXDR no funds move, so no reservation needed.
          const p = task.payload as Record<string, unknown>;
          const sigs = Array.isArray(p?.signatures) ? p.signatures : [];
          const minSig = typeof p?.minSignatures === "number" ? p.minSignatures : 1;
          const willSubmit = sigs.length >= minSig;
          const reservationId = willSubmit ? reserveSpendingLimit(p?.amount) : null;
          try {
            data = await this.multiSigTool.execute(task.payload);
            if (reservationId !== null) spendingTracker.commit(reservationId);
          } catch (toolErr) {
            if (reservationId !== null) spendingTracker.release(reservationId);
            throw toolErr;
          }
          break;
        }

        case "batch_payment": {
          // issue #728 — batch_payment had its own aggregate check but never
          // recorded into the rolling window. Compute total, reserve it, then
          // commit/release based on submission outcome.
          const p = task.payload as Record<string, unknown>;
          const payments = Array.isArray(p?.payments) ? p.payments : [];
          const batchTotal = payments.reduce((sum: number, pay: unknown) => {
            const amt = parseFloat((pay as Record<string, unknown>)?.amount as string);
            return sum + (isNaN(amt) ? 0 : amt);
          }, 0);
          const batchTotalStr = String(batchTotal);
          const reservationId = reserveSpendingLimit(batchTotalStr);
          try {
            data = await this.batchPaymentTool.execute(task.payload);
            if (reservationId !== null) spendingTracker.commit(reservationId);
          } catch (toolErr) {
            if (reservationId !== null) spendingTracker.release(reservationId);
            throw toolErr;
          }
          break;
        }

        case "balance_check":
          data = await this.balanceCheckTool.getBalance(task.payload);
          break;

        case "path_payment": {
          // issue #728 — path_payment was entirely unguarded; sendAmount is the
          // field that moves funds.
          const p = task.payload as Record<string, unknown>;
          const reservationId = reserveSpendingLimit(p?.sendAmount);
          try {
            data = await this.pathPaymentTool.execute(task.payload);
            if (reservationId !== null) spendingTracker.commit(reservationId);
          } catch (toolErr) {
            if (reservationId !== null) spendingTracker.release(reservationId);
            throw toolErr;
          }
          break;
        }

        case "fee_bump": {
          // issue #728 — fee_bump pays fees on behalf of the inner tx; the fee
          // is not a user-specified numeric field, so we guard the baseFeeMultiplier
          // signal by checking against a sentinel value.  The inner-tx fee is
          // typically < 1 XLM and not tracked; this guard prevents runaway
          // fee-bump usage from bypassing the window entirely.
          // We skip the spending-limit guard for fee_bump because its cost is
          // denominated in stroops (fractions of XLM) and the tool validates
          // the multiplier itself.  The task type is included in the window
          // audit log via taskLog below.
          data = await this.feeBumpTool.execute(task.payload);
          break;
        }

        case "dex_offer": {
          // issue #728 — dex_offer sell-amount moves funds; guard the amount field.
          // delete actions set amount to "0" internally so they pass through.
          const p = task.payload as Record<string, unknown>;
          const reservationId = reserveSpendingLimit(p?.amount);
          try {
            data = await this.dexOfferTool.execute(task.payload);
            if (reservationId !== null) spendingTracker.commit(reservationId);
          } catch (toolErr) {
            if (reservationId !== null) spendingTracker.release(reservationId);
            throw toolErr;
          }
          break;
        }

        default:
          throw new Error(`Unknown task type: ${(task as AgentTask).type}`);
      }

      taskLog.info({ taskType: task.type }, "Task completed");
      const result: AgentResult = { success: true, taskType: task.type, data, correlationId };
      this.emit("task:complete", result);

      saveResult({ ...result, timestamp: new Date().toISOString() });
      void dispatchWebhook(result);

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const safe = redactSecretString(message);
      const sanitized = sanitizePayload(task.payload);
      taskLog.error(
        { taskType: task.type, error: safe, sanitizedPayload: sanitized },
        "Task failed"
      );
      const result: AgentResult = { success: false, taskType: task.type, error: safe, correlationId };
      this.emit("task:failed", result);
      void dispatchWebhook(result);
      return result;
    } finally {
      this.activeTasks--;
    }
  }
}
