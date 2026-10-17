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
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { rpc } from '@stellar/stellar-sdk';
import { config, MAINNET_SPENDING_CAP } from './config';
import { logger } from './logger';
import { saveResult, appendAuditEntry, type AuditEntry } from './persistence';
import { StructuredError, getErrorType, sanitizeCause } from './errors';
import { X402Challenge, X402ChallengeSchema } from './tools/X402PaymentTool';
import type { AgentTool, ToolContext } from './tools/AgentTool';
import { createBuiltinTools } from './tools/builtin';
import { listen as listenContractEvents } from './tools/ContractEventListener';
import {
  watchContractStorage,
  ContractStorageWatcherOptions,
  StorageChangeEvent,
} from './tools/ContractStorageWatcherTool';

import { horizonServer } from './rpc_client';
import * as rpcClient from './rpc_client';
import { createLogger, generateCorrelationId } from './utils/logger';
import { spendingTracker } from './spending_tracker';
import { dispatchWebhook } from './webhook';

// Re-exported so existing importers (`server.ts`, tests) keep working after the
// singleton moved to spending_tracker.ts.
export { spendingTracker };

// ─── Spending limit guard ─────────────────────────────────────────────────────

/**
 * Check that a payment amount does not exceed the configured spending limit.
 * Also enforces cumulative spending within the sliding window.
 */
function assertWithinSpendingLimit(amount: unknown): void {
  if (typeof amount !== 'string') return; // let the tool's own schema catch this

  const parsed = parseFloat(amount);
  const limit = parseFloat(config.AGENT_SPENDING_LIMIT);

  if (!isNaN(parsed) && parsed > limit) {
    throw new Error(
      `Payment amount ${amount} ${config.X402_ASSET_CODE} exceeds ` +
        `AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
    );
  }
  if (!isNaN(parsed) && config.STELLAR_NETWORK === 'mainnet' && parsed > MAINNET_SPENDING_CAP) {
    throw new Error(
      `Payment amount ${amount} ${config.X402_ASSET_CODE} exceeds ` +
        `mainnet spending cap of ${MAINNET_SPENDING_CAP}`
    );
  }

  // Record cumulative spending (after individual checks pass)
  spendingTracker.record(amount);
}

const log = createLogger('orchestrator');

// ─── Task types ───────────────────────────────────────────────────────────────

/** Task types handled by the tools PayFiAgent registers at construction. */
export type BuiltinTaskType =
  | 'stellar_payment'
  | 'soroban_invoke'
  | 'soroban_query'
  | 'x402_respond'
  | 'account_info'
  | 'change_trust'
  | 'multisig_payment'
  | 'batch_payment'
  | 'balance_check'
  | 'path_payment'
  | 'fee_bump'
  | 'dex_offer'
  | 'liquidity_pool'
  | 'stellar_toml'
  | 'data_entry'
  | 'sequence_number'
  | 'sponsored_account'
  | 'anchor_quote'
  | 'inflation'
  | 'soroban_deploy'
  | 'swap'
  | 'account_history'
  | 'set_options'
  | 'soroban_event_query'
  | 'stellar_identity_auth'
  | 'friendbot'
  | 'ledger_info'
  | 'network_status'
  | 'offer_book'
  | 'soroban_storage';

/**
 * Any task type `run()` accepts: a built-in one, or the name of a tool added
 * with {@link PayFiAgent.registerTool}. Intersecting `string` with an empty
 * record keeps editor completion for the built-in names while allowing
 * third-party ones.
 */
export type TaskType = BuiltinTaskType | (string & Record<never, never>);

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
  /** Wall-clock time in milliseconds spent executing the task (from dispatch to completion/failure). */
  durationMs?: number;
  /**
   * Zero-based position of the task within the {@link PayFiAgent.runSequence}
   * call that produced this result. Because `runSequence` stops at the first
   * failure, the last entry's `sequenceIndex` is the index of the task that
   * failed — callers no longer have to infer it from array position, which
   * breaks as soon as results are filtered, sorted, or merged.
   *
   * Absent on results from {@link PayFiAgent.run}, which has no sequence.
   */
  sequenceIndex?: number;
}

// ─── Middleware types ─────────────────────────────────────────────────────────────

/**
 * Task middleware function type.
 *
 * Middleware functions are executed in registration order before the task
 * is dispatched to the appropriate tool. Each middleware receives the task
 * and a `next` function to continue execution. Calling `next()` passes control
 * to the next middleware or the actual task execution. If a middleware returns
 * a result without calling `next()`, it short-circuits execution.
 *
 * @param task - The task to be executed
 * @param next - Function to call the next middleware or the actual task
 * @returns The result of task execution or middleware short-circuit
 */
export type TaskMiddleware = (
  task: AgentTask,
  next: () => Promise<AgentResult>
) => Promise<AgentResult>;

// ─── Payload sanitisation ─────────────────────────────────────────────────────

const SECRET_KEY_RE = /^(?<prefix>.*?["':\s]?)(?<secret>S[ A-Z2-7]{55})(?<suffix>["'\s]?.*)$/i;

function redactSecretString(value: string): string {
  return value.replace(SECRET_KEY_RE, '$<prefix>[REDACTED]$<suffix>');
}

/**
 * Render an error as the string that goes into {@link AgentResult.error}.
 *
 * A {@link StructuredError} may carry a `cause` holding the context needed to
 * act on the failure automatically — for an auth rejection, which signer was
 * presented and which one was expected. That context is JSON-serialised onto
 * the end of the message so it survives into persisted results and webhook
 * payloads, both of which only carry the string.
 *
 * The cause is passed through `sanitizeCause` first, so signing material can
 * never be serialised out this way, and the whole string is redacted by the
 * caller afterwards as a second line of defence.
 */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof StructuredError) || err.cause === undefined) {
    return message;
  }
  try {
    const context = JSON.stringify(sanitizeCause(err.cause));
    // `undefined` and functions serialise to undefined rather than a string.
    return context === undefined ? message : `${message} | context: ${context}`;
  } catch {
    // Circular or otherwise unserialisable cause: the message alone still has
    // to get through, so a failure here must not lose the error entirely.
    return message;
  }
}

function sanitizePayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload;
  if (Array.isArray(payload)) return payload.map(sanitizePayload);

  const sanitized: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(payload as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (/secret|key|seed|mnemonic|private/i.test(key)) continue;
    sanitized[key] = sanitizePayload(rawValue);
  }
  return sanitized;
}

// ─── Audit log ────────────────────────────────────────────────────────────────

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Build the audit-log entry for a task that produced a signed transaction, or
 * `null` when the result carries no `txHash` (read-only tasks, simulations,
 * multisig envelopes still awaiting signatures). Friendbot transactions are
 * signed by the Friendbot service, not the agent, so they are not recorded.
 */
function buildAuditEntry(
  task: AgentTask,
  data: unknown,
  correlationId: string,
  ts: string
): AuditEntry | null {
  if (task.type === 'friendbot' || data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const txHash = optionalString(d.txHash);
  if (!txHash) return null;

  const p = (task.payload ?? {}) as Record<string, unknown>;
  const envelopeXdr = optionalString(d.envelopeXdr ?? d.envelope_xdr);
  const assetCode = optionalString(p.assetCode);
  const assetIssuer = optionalString(p.assetIssuer);

  return {
    ts,
    correlationId,
    taskType: task.type,
    txHash,
    envelopeHash: envelopeXdr ? createHash('sha256').update(envelopeXdr).digest('hex') : null,
    destination: optionalString(p.destination ?? p.payTo),
    asset: assetCode ? (assetIssuer ? `${assetCode}:${assetIssuer}` : assetCode) : null,
    amount: optionalString(p.amount),
  };
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export class PayFiAgent extends EventEmitter {
  // Tool registry — every task type run() can dispatch, keyed by tool name.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tools = new Map<TaskType, AgentTool<any, any>>();

  private activeTasks = 0;
  private isDraining = false;
  private readonly taskQueue: Array<{
    task: AgentTask;
    correlationId: string;
    resolve: (result: AgentResult) => void;
  }> = [];
  private _streamStop: (() => void) | null = null;
  private _contractListenerStop: (() => void) | null = null;
  private _storageWatcherStop: (() => void) | null = null;

  // Bound handler references kept so destroy() can call .off() with the exact same function
  // reference — EventEmitter requires identity equality for removal.
  private readonly _boundHandlers = new Map<string, (...args: unknown[]) => void>();

  // Middleware array for pre/post task execution hooks
  private middlewares: TaskMiddleware[] = [];

  constructor() {
    super();

    for (const tool of createBuiltinTools()) {
      this.registerTool(tool);
    }

    // ── Register event listeners — every registration is mirrored in destroy() ──
    const onError = (err: Error) => {
      const safe = err.message.replace(/S[A-Z2-7]{55}/g, '[REDACTED]');
      logger.error('Unhandled agent error', { error: safe });
    };
    const onTaskComplete = (result: AgentResult) => {
      logger.info('Task complete', { taskType: result.taskType });
    };
    const onTaskFailed = (result: AgentResult) => {
      logger.warn('Task failed', { taskType: result.taskType, error: result.error });
    };

    this.on('error', onError);
    this.on('task:complete', onTaskComplete);
    this.on('task:failed', onTaskFailed);

    this._boundHandlers.set('error', onError as (...args: unknown[]) => void);
    this._boundHandlers.set('task:complete', onTaskComplete as (...args: unknown[]) => void);
    this._boundHandlers.set('task:failed', onTaskFailed as (...args: unknown[]) => void);

    // Log only safe fields — public key is derived, not the secret
    logger.info('PayFiAgent initialised', {
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
          const memo: string = payment.memo ?? '';
          if (!memo.startsWith('x402:')) return;
          try {
            const raw: unknown = JSON.parse(Buffer.from(memo.slice(5), 'base64').toString('utf8'));
            const challenge: X402Challenge = X402ChallengeSchema.parse(raw);
            onChallenge(challenge);
          } catch (err) {
            // Malformed or schema-invalid memo — log and drop rather than
            // forwarding to onChallenge (or letting Zod's error surface
            // deep inside respond(), where it can't be attributed to the
            // stream that produced it).
            logger.warn('Dropped invalid x402 challenge memo', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
        onerror: (event: MessageEvent) => {
          logger.warn('Payment stream error', { error: String(event) });
          // The underlying connection is dead — tear it down so `_streamStop`
          // doesn't keep pointing at a broken stream forever, which would
          // otherwise permanently block a future startListening() call (its
          // early-return guard only checks whether `_streamStop` is set).
          this.stopListening();
        },
      });

    this._streamStop = closeStream as unknown as () => void;
    logger.info('Payment stream started', { resourceUrl });
  }

  /** Stop the active Horizon payment stream subscription. */
  stopListening(): void {
    if (this._streamStop) {
      this._streamStop();
      this._streamStop = null;
      logger.info('Payment stream stopped');
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
    logger.info('Contract event listener started', { contractId });
  }

  /** Stop the active contract event listener. */
  stopContractListener(): void {
    if (this._contractListenerStop) {
      this._contractListenerStop();
      this._contractListenerStop = null;
      logger.info('Contract event listener stopped');
    }
  }

  /**
   * Start polling a Soroban contract's storage keys for changes.
   * Calls onChange for each detected key addition, update, or deletion.
   */
  startStorageWatcher(
    options: ContractStorageWatcherOptions,
    onChange: (event: StorageChangeEvent) => void
  ): void {
    if (this._storageWatcherStop) {
      this._storageWatcherStop();
    }
    const handle = watchContractStorage(options);
    handle.on('change', onChange);
    this._storageWatcherStop = handle.stop;
    logger.info('Contract storage watcher started', { contractId: options.contractId });
  }

  /** Stop the active contract storage watcher. */
  stopStorageWatcher(): void {
    if (this._storageWatcherStop) {
      this._storageWatcherStop();
      this._storageWatcherStop = null;
      logger.info('Contract storage watcher stopped');
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
    this.stopStorageWatcher();
    for (const [event, handler] of this._boundHandlers) {
      this.off(event, handler);
    }
    this._boundHandlers.clear();
    // Remove any listeners added externally after construction
    this.removeAllListeners();
    logger.info('Agent destroyed — all event listeners removed');
  }

  drain(): void {
    this.isDraining = true;
    logger.info('Agent draining — rejecting new tasks');
  }

  /**
   * Register a middleware function for pre/post task execution hooks.
   *
   * Middleware functions are executed in registration order before the task
   * is dispatched to the appropriate tool. Each middleware can:
   * - Inspect and modify the task
   * - Short-circuit execution by returning a result without calling next()
   * - Call next() to continue to the next middleware or actual task execution
   *
   * @param middleware - Middleware function to register
   */
  use(middleware: TaskMiddleware): void {
    this.middlewares.push(middleware);
    logger.info('Middleware registered', { totalMiddlewares: this.middlewares.length });
  }

  /**
   * Register a tool so `run({ type: tool.name, payload })` dispatches to it.
   *
   * The payload is parsed with `tool.inputSchema` before `tool.execute` is
   * called, so the tool receives validated input. Names must be unique —
   * registering a name that is already taken throws rather than silently
   * replacing a built-in tool.
   *
   * @param tool - The tool to register.
   */
  registerTool<I, O>(tool: AgentTool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`A tool named "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Every registered tool, in registration order. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTools(): AgentTool<any, any>[] {
    return [...this.tools.values()];
  }

  async waitForPendingTasks(): Promise<void> {
    if (this.activeTasks === 0 && this.taskQueue.length === 0) return;
    logger.info('Waiting for pending tasks to finish', {
      activeTasks: this.activeTasks,
      queuedTasks: this.taskQueue.length,
    });
    return new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (this.activeTasks === 0 && this.taskQueue.length === 0) {
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
    for (const [index, task] of tasks.entries()) {
      const result = await this.run(task);
      // Stamped on a copy rather than mutating the object `run` already handed
      // to the "task:failed" listeners and the webhook dispatcher.
      results.push({ ...result, sequenceIndex: index });
      if (!result.success) break;
    }
    return results;
  }

  /** Dispatch a task to the correct tool */
  async run(task: AgentTask): Promise<AgentResult> {
    // Correlation ID ties together every log line, event, persisted result,
    // and webhook for this single task execution. Reuse the caller's if given.
    const correlationId = task.correlationId ?? generateCorrelationId();
    const taskLog = createLogger('orchestrator', correlationId);

    if (this.isDraining) {
      return {
        success: false,
        taskType: task.type,
        error: 'Agent is shutting down — task rejected',
        correlationId,
      };
    }

    // ── Concurrency rate limit — queue when saturated if queueCapacity allows,
    // otherwise reject ──
    if (this.activeTasks >= config.MAX_CONCURRENT_TASKS) {
      if (config.QUEUE_CAPACITY > 0 && this.taskQueue.length < config.QUEUE_CAPACITY) {
        taskLog.info(
          {
            taskType: task.type,
            activeTasks: this.activeTasks,
            queueLength: this.taskQueue.length + 1,
          },
          'Agent at capacity — task queued'
        );
        return new Promise<AgentResult>((resolve) => {
          this.taskQueue.push({ task, correlationId, resolve });
        });
      }

      taskLog.warn(
        {
          taskType: task.type,
          activeTasks: this.activeTasks,
          maxConcurrentTasks: config.MAX_CONCURRENT_TASKS,
        },
        'Task rejected — max concurrent tasks reached'
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

    return this.executeTask(task, correlationId, taskLog);
  }

  /**
   * Pull the next queued task (if any) and dispatch it once a concurrency
   * slot frees up. Called from executeTask()'s `finally` block.
   */
  private dispatchQueued(): void {
    if (this.taskQueue.length === 0) return;
    if (this.activeTasks >= config.MAX_CONCURRENT_TASKS) return;
    const next = this.taskQueue.shift();
    if (!next) return;
    void this.executeTask(
      next.task,
      next.correlationId,
      createLogger('orchestrator', next.correlationId)
    ).then(next.resolve);
  }

  /** Run a task's tool logic — assumes the concurrency slot has already been reserved. */
  private async executeTask(
    task: AgentTask,
    correlationId: string,
    taskLog: ReturnType<typeof createLogger>
  ): Promise<AgentResult> {
    this.activeTasks++;
    const startMs = Date.now();
    taskLog.info({ taskType: task.type }, 'Running task');

    // ── Compose middleware chain ────────────────────────────────────────────────
    const executeTask = async (): Promise<AgentResult> => {
      try {
        const tool = this.tools.get(task.type);
        if (!tool) {
          throw new Error(`Unknown task type: ${(task as AgentTask).type}`);
        }

        const ctx: ToolContext = {
          correlationId,
          logger: taskLog,
          network: config.STELLAR_NETWORK,
          assertWithinSpendingLimit,
        };
        const input = tool.inputSchema.parse(task.payload);
        const data: unknown = await tool.execute(input, ctx);

        taskLog.info({ taskType: task.type }, 'Task completed');
        const result: AgentResult = { success: true, taskType: task.type, data, correlationId };
        this.emit('task:complete', result);

        const timestamp = new Date().toISOString();
        saveResult({ ...result, timestamp });

        // The transaction is already on-chain at this point, so an audit-log
        // failure is logged loudly rather than reported as a task failure that
        // could prompt the caller to resubmit the payment.
        try {
          const auditEntry = buildAuditEntry(task, data, correlationId, timestamp);
          if (auditEntry) appendAuditEntry(auditEntry);
        } catch (auditErr) {
          taskLog.error(
            {
              taskType: task.type,
              error: redactSecretString(describeError(auditErr)),
            },
            'Failed to append audit log entry'
          );
        }

        void dispatchWebhook(result);

        return result;
      } catch (err) {
        const safe = redactSecretString(describeError(err));
        const sanitized = sanitizePayload(task.payload);
        taskLog.error(
          { taskType: task.type, error: safe, sanitizedPayload: sanitized },
          'Task failed'
        );
        const result: AgentResult = {
          success: false,
          taskType: task.type,
          error: safe,
          errorType: getErrorType(err),
          correlationId,
        };
        this.emit('task:failed', result);
        void dispatchWebhook(result);
        return result;
      }
    };

    // Build middleware chain: middleware[n] -> middleware[n-1] -> ... -> executeTask
    let chain: () => Promise<AgentResult> = executeTask;
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const middleware = this.middlewares[i];
      if (!middleware) continue;
      const next: () => Promise<AgentResult> = chain;
      chain = () => middleware(task, next);
    }

    try {
      return await chain();
    } catch (err) {
      const durationMs = Date.now() - startMs;
      const safe = redactSecretString(describeError(err));
      const sanitized = sanitizePayload(task.payload);
      taskLog.error(
        { taskType: task.type, error: safe, sanitizedPayload: sanitized, durationMs },
        'Task failed'
      );
      const isStellarRpcError =
        !!rpcClient.StellarRPCError && err instanceof rpcClient.StellarRPCError;
      if (isStellarRpcError) {
        this.emit('task:retry_exhausted', { taskType: task.type, attempts: config.MAX_RETRIES });
      }
      const result: AgentResult = {
        success: false,
        taskType: task.type,
        error: safe,
        errorType: getErrorType(err),
        correlationId,
        durationMs,
      };
      this.emit('task:failed', result);
      void dispatchWebhook(result);
      return result;
    } finally {
      this.activeTasks--;
      this.dispatchQueued();
    }
  }
}
