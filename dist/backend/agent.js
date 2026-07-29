"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PayFiAgent = exports.spendingTracker = void 0;
// Updated imports
const events_1 = require("events");
const config_1 = require("./config");
const logger_1 = require("./logger");
const persistence_1 = require("./persistence");
const errors_1 = require("./errors");
const StellarPaymentTool_1 = require("./tools/StellarPaymentTool");
const SorobanInvokeTool_1 = require("./tools/SorobanInvokeTool");
const X402PaymentTool_1 = require("./tools/X402PaymentTool");
const AccountInfoTool_1 = require("./tools/AccountInfoTool");
const TrustlineTool_1 = require("./tools/TrustlineTool");
const MultiSigPaymentTool_1 = require("./tools/MultiSigPaymentTool");
const BatchPaymentTool_1 = require("./tools/BatchPaymentTool");
const SorobanQueryTool_1 = require("./tools/SorobanQueryTool");
const BalanceCheckTool_1 = require("./tools/BalanceCheckTool");
const PathPaymentTool_1 = require("./tools/PathPaymentTool");
const FeeBumpTool_1 = require("./tools/FeeBumpTool");
const DexOfferTool_1 = require("./tools/DexOfferTool");
const ContractEventListener_1 = require("./tools/ContractEventListener");
const rpc_client_1 = require("./rpc_client");
const logger_2 = require("./utils/logger");
const spending_tracker_1 = require("./spending_tracker");
const webhook_1 = require("./webhook");
// Instantiate a singleton tracker
exports.spendingTracker = new spending_tracker_1.SpendingTracker();
// ─── Spending limit guard ─────────────────────────────────────────────────────
/**
 * Check that a payment amount does not exceed the configured spending limit.
 * Also enforces cumulative spending within the sliding window.
 */
function assertWithinSpendingLimit(amount) {
    if (typeof amount !== "string")
        return; // let the tool's own schema catch this
    const parsed = parseFloat(amount);
    const limit = parseFloat(config_1.config.AGENT_SPENDING_LIMIT);
    if (!isNaN(parsed) && parsed > limit) {
        throw new Error(`Payment amount ${amount} ${config_1.config.X402_ASSET_CODE} exceeds ` +
            `AGENT_SPENDING_LIMIT of ${config_1.config.AGENT_SPENDING_LIMIT}`);
    }
    if (!isNaN(parsed) && config_1.config.STELLAR_NETWORK === "mainnet" && parsed > config_1.MAINNET_SPENDING_CAP) {
        throw new Error(`Payment amount ${amount} ${config_1.config.X402_ASSET_CODE} exceeds ` +
            `mainnet spending cap of ${config_1.MAINNET_SPENDING_CAP}`);
    }
    // Record cumulative spending (after individual checks pass)
    exports.spendingTracker.record(amount);
}
const log = (0, logger_2.createLogger)("orchestrator");
// ─── Payload sanitisation ─────────────────────────────────────────────────────
const SECRET_KEY_RE = /^(?<prefix>.*?["':\s]?)(?<secret>S[ A-Z2-7]{55})(?<suffix>["'\s]?.*)$/i;
function redactSecretString(value) {
    return value.replace(SECRET_KEY_RE, "$<prefix>[REDACTED]$<suffix>");
}
function sanitizePayload(payload) {
    if (payload === null || typeof payload !== "object")
        return payload;
    if (Array.isArray(payload))
        return payload.map(sanitizePayload);
    const sanitized = {};
    for (const [rawKey, rawValue] of Object.entries(payload)) {
        const key = rawKey.trim();
        if (/secret|key|seed|mnemonic|private/i.test(key))
            continue;
        sanitized[key] = sanitizePayload(rawValue);
    }
    return sanitized;
}
// ─── Agent ────────────────────────────────────────────────────────────────────
class PayFiAgent extends events_1.EventEmitter {
    paymentTool;
    sorobanTool;
    sorobanQueryTool;
    x402Tool;
    accountInfoTool;
    trustlineTool;
    multiSigTool;
    batchPaymentTool;
    balanceCheckTool;
    pathPaymentTool;
    feeBumpTool;
    dexOfferTool;
    activeTasks = 0;
    isDraining = false;
    taskQueue = [];
    _streamStop = null;
    _contractListenerStop = null;
    // Bound handler references kept so destroy() can call .off() with the exact same function
    // reference — EventEmitter requires identity equality for removal.
    _boundHandlers = new Map();
    // Middleware array for pre/post task execution hooks
    middlewares = [];
    constructor() {
        super();
        // config.agentKeypair().secret() is the canonical way to obtain the signing secret.
        // Direct access to config.AGENT_SECRET_KEY is intentionally blocked by the AgentConfig
        // type (Omit<RawEnv, "AGENT_SECRET_KEY">); using agentKeypair() makes the access explicit.
        this.paymentTool = new StellarPaymentTool_1.StellarPaymentTool(config_1.config.agentKeypair().secret());
        this.sorobanTool = new SorobanInvokeTool_1.SorobanInvokeTool(config_1.config.agentKeypair().secret());
        this.sorobanQueryTool = new SorobanQueryTool_1.SorobanQueryTool(config_1.config.agentKeypair().secret());
        this.x402Tool = new X402PaymentTool_1.X402PaymentTool(config_1.config.agentKeypair().secret());
        this.accountInfoTool = new AccountInfoTool_1.AccountInfoTool();
        this.trustlineTool = new TrustlineTool_1.TrustlineTool(config_1.config.agentKeypair().secret());
        this.multiSigTool = new MultiSigPaymentTool_1.MultiSigPaymentTool(config_1.config.agentKeypair().secret());
        this.batchPaymentTool = new BatchPaymentTool_1.BatchPaymentTool(config_1.config.agentKeypair().secret());
        this.balanceCheckTool = new BalanceCheckTool_1.BalanceCheckTool();
        this.pathPaymentTool = new PathPaymentTool_1.PathPaymentTool(config_1.config.agentKeypair().secret());
        this.feeBumpTool = new FeeBumpTool_1.FeeBumpTool(config_1.config.agentKeypair().secret());
        this.dexOfferTool = new DexOfferTool_1.DexOfferTool(config_1.config.agentKeypair().secret());
        // ── Register event listeners — every registration is mirrored in destroy() ──
        const onError = (err) => {
            const safe = err.message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
            logger_1.logger.error("Unhandled agent error", { error: safe });
        };
        const onTaskComplete = (result) => {
            logger_1.logger.info("Task complete", { taskType: result.taskType });
        };
        const onTaskFailed = (result) => {
            logger_1.logger.warn("Task failed", { taskType: result.taskType, error: result.error });
        };
        this.on("error", onError);
        this.on("task:complete", onTaskComplete);
        this.on("task:failed", onTaskFailed);
        this._boundHandlers.set("error", onError);
        this._boundHandlers.set("task:complete", onTaskComplete);
        this._boundHandlers.set("task:failed", onTaskFailed);
        // Log only safe fields — public key is derived, not the secret
        logger_1.logger.info("PayFiAgent initialised", {
            network: config_1.config.STELLAR_NETWORK,
            horizon: config_1.config.HORIZON_URL,
            soroban: config_1.config.SOROBAN_RPC_URL,
            agentPubkey: config_1.config.AGENT_PUBLIC_KEY,
            spendingLimit: config_1.config.AGENT_SPENDING_LIMIT,
            assetCode: config_1.config.X402_ASSET_CODE,
        });
    }
    /**
     * Start polling the Horizon payment stream for incoming x402 challenges.
     * Calls onChallenge for each payment whose memo starts with "x402:".
     */
    startListening(resourceUrl, onChallenge) {
        if (this._streamStop)
            return; // already listening
        const closeStream = rpc_client_1.horizonServer
            .payments()
            .forAccount(config_1.config.AGENT_PUBLIC_KEY)
            .stream({
            onmessage: (payment) => {
                const memo = payment.memo ?? "";
                if (!memo.startsWith("x402:"))
                    return;
                try {
                    const raw = JSON.parse(Buffer.from(memo.slice(5), "base64").toString("utf8"));
                    const challenge = X402PaymentTool_1.X402ChallengeSchema.parse(raw);
                    onChallenge(challenge);
                }
                catch (err) {
                    // Malformed or schema-invalid memo — log and drop rather than
                    // forwarding to onChallenge (or letting Zod's error surface
                    // deep inside respond(), where it can't be attributed to the
                    // stream that produced it).
                    logger_1.logger.warn("Dropped invalid x402 challenge memo", {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            },
            onerror: (event) => {
                logger_1.logger.warn("Payment stream error", { error: String(event) });
            },
        });
        this._streamStop = closeStream;
        logger_1.logger.info("Payment stream started", { resourceUrl });
    }
    /** Stop the active Horizon payment stream subscription. */
    stopListening() {
        if (this._streamStop) {
            this._streamStop();
            this._streamStop = null;
            logger_1.logger.info("Payment stream stopped");
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
    startContractListener(contractId, eventTypes, onEvent) {
        if (this._contractListenerStop) {
            this._contractListenerStop();
        }
        this._contractListenerStop = (0, ContractEventListener_1.listen)(contractId, eventTypes, onEvent);
        logger_1.logger.info("Contract event listener started", { contractId });
    }
    /** Stop the active contract event listener. */
    stopContractListener() {
        if (this._contractListenerStop) {
            this._contractListenerStop();
            this._contractListenerStop = null;
            logger_1.logger.info("Contract event listener stopped");
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
    destroy() {
        this.stopListening();
        this.stopContractListener();
        for (const [event, handler] of this._boundHandlers) {
            this.off(event, handler);
        }
        this._boundHandlers.clear();
        // Remove any listeners added externally after construction
        this.removeAllListeners();
        logger_1.logger.info("Agent destroyed — all event listeners removed");
    }
    drain() {
        this.isDraining = true;
        logger_1.logger.info("Agent draining — rejecting new tasks");
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
    use(middleware) {
        this.middlewares.push(middleware);
        logger_1.logger.info("Middleware registered", { totalMiddlewares: this.middlewares.length });
    }
    async waitForPendingTasks() {
        if (this.activeTasks === 0 && this.taskQueue.length === 0)
            return;
        logger_1.logger.info("Waiting for pending tasks to finish", {
            activeTasks: this.activeTasks,
            queuedTasks: this.taskQueue.length,
        });
        return new Promise((resolve) => {
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
    async runSequence(tasks) {
        const results = [];
        for (const task of tasks) {
            const result = await this.run(task);
            results.push(result);
            if (!result.success)
                break;
        }
        return results;
    }
    /** Dispatch a task to the correct tool */
    async run(task) {
        // Correlation ID ties together every log line, event, persisted result,
        // and webhook for this single task execution. Reuse the caller's if given.
        const correlationId = task.correlationId ?? (0, logger_2.generateCorrelationId)();
        const taskLog = (0, logger_2.createLogger)("orchestrator", correlationId);
        if (this.isDraining) {
            return {
                success: false,
                taskType: task.type,
                error: "Agent is shutting down — task rejected",
                correlationId,
            };
        }
        // ── Concurrency rate limit — queue when saturated if queueCapacity allows,
        // otherwise reject ──
        if (this.activeTasks >= config_1.config.MAX_CONCURRENT_TASKS) {
            if (config_1.config.QUEUE_CAPACITY > 0 && this.taskQueue.length < config_1.config.QUEUE_CAPACITY) {
                taskLog.info({
                    taskType: task.type,
                    activeTasks: this.activeTasks,
                    queueLength: this.taskQueue.length + 1,
                }, "Agent at capacity — task queued");
                return new Promise((resolve) => {
                    this.taskQueue.push({ task, correlationId, resolve });
                });
            }
            taskLog.warn({
                taskType: task.type,
                activeTasks: this.activeTasks,
                maxConcurrentTasks: config_1.config.MAX_CONCURRENT_TASKS,
            }, "Task rejected — max concurrent tasks reached");
            return {
                success: false,
                taskType: task.type,
                error: `Agent is at capacity — ${this.activeTasks}/${config_1.config.MAX_CONCURRENT_TASKS} ` +
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
    dispatchQueued() {
        if (this.taskQueue.length === 0)
            return;
        if (this.activeTasks >= config_1.config.MAX_CONCURRENT_TASKS)
            return;
        const next = this.taskQueue.shift();
        if (!next)
            return;
        void this.executeTask(next.task, next.correlationId, (0, logger_2.createLogger)("orchestrator", next.correlationId)).then(next.resolve);
    }
    /** Run a task's tool logic — assumes the concurrency slot has already been reserved. */
    async executeTask(task, correlationId, taskLog) {
        this.activeTasks++;
        taskLog.info({ taskType: task.type }, "Running task");
        // ── Compose middleware chain ────────────────────────────────────────────────
        const executeTask = async () => {
            try {
                let data;
                switch (task.type) {
                    case "stellar_payment": {
                        const p = task.payload;
                        assertWithinSpendingLimit(p?.amount);
                        const paymentResult = await this.paymentTool.execute(task.payload);
                        data = {
                            ...paymentResult,
                            network: config_1.config.STELLAR_NETWORK,
                        };
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
                        const p = task.payload;
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
                    case "batch_payment":
                        data = await this.batchPaymentTool.execute(task.payload);
                        break;
                    case "balance_check":
                        data = await this.balanceCheckTool.getBalance(task.payload);
                        break;
                    case "path_payment":
                        data = await this.pathPaymentTool.execute(task.payload);
                        break;
                    case "fee_bump":
                        data = await this.feeBumpTool.execute(task.payload);
                        break;
                    case "dex_offer":
                        data = await this.dexOfferTool.execute(task.payload);
                        break;
                    default:
                        throw new Error(`Unknown task type: ${task.type}`);
                }
                taskLog.info({ taskType: task.type }, "Task completed");
                const result = { success: true, taskType: task.type, data, correlationId };
                this.emit("task:complete", result);
                (0, persistence_1.saveResult)({ ...result, timestamp: new Date().toISOString() });
                void (0, webhook_1.dispatchWebhook)(result);
                return result;
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const safe = redactSecretString(message);
                const sanitized = sanitizePayload(task.payload);
                taskLog.error({ taskType: task.type, error: safe, sanitizedPayload: sanitized }, "Task failed");
                const result = {
                    success: false,
                    taskType: task.type,
                    error: safe,
                    errorType: (0, errors_1.getErrorType)(err),
                    correlationId,
                };
                this.emit("task:failed", result);
                void (0, webhook_1.dispatchWebhook)(result);
                return result;
            }
        };
        // Build middleware chain: middleware[n] -> middleware[n-1] -> ... -> executeTask
        let chain = executeTask;
        for (let i = this.middlewares.length - 1; i >= 0; i--) {
            const middleware = this.middlewares[i];
            if (!middleware)
                continue;
            const next = chain;
            chain = () => middleware(task, next);
        }
        try {
            return await chain();
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const safe = redactSecretString(message);
            const sanitized = sanitizePayload(task.payload);
            taskLog.error({ taskType: task.type, error: safe, sanitizedPayload: sanitized }, "Task failed");
            if (err instanceof rpc_client_1.StellarRPCError) {
                this.emit("task:retry_exhausted", { taskType: task.type, attempts: config_1.config.MAX_RETRIES });
            }
            const result = {
                success: false,
                taskType: task.type,
                error: safe,
                errorType: (0, errors_1.getErrorType)(err),
                correlationId,
            };
            this.emit("task:failed", result);
            void (0, webhook_1.dispatchWebhook)(result);
            return result;
        }
        finally {
            this.activeTasks--;
            this.dispatchQueued();
        }
    }
}
exports.PayFiAgent = PayFiAgent;
//# sourceMappingURL=agent.js.map