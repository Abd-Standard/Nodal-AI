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
exports.PayFiAgent = void 0;
const events_1 = require("events");
const config_1 = require("./config");
const logger_1 = require("./logger");
const StellarPaymentTool_1 = require("./tools/StellarPaymentTool");
const SorobanInvokeTool_1 = require("./tools/SorobanInvokeTool");
const X402PaymentTool_1 = require("./tools/X402PaymentTool");
const logger_2 = require("./utils/logger");
const log = (0, logger_2.createLogger)("orchestrator");
// ─── Spending limit guard ─────────────────────────────────────────────────────
/**
 * Check that a payment amount does not exceed the configured spending limit.
 * Called before delegating to StellarPaymentTool or X402PaymentTool.
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
}
// ─── Agent ────────────────────────────────────────────────────────────────────
class PayFiAgent extends events_1.EventEmitter {
    paymentTool;
    sorobanTool;
    x402Tool;
    activeTasks = 0;
    isDraining = false;
    // Bound handler references kept so destroy() can call .off() with the exact same function
    // reference — EventEmitter requires identity equality for removal.
    _boundHandlers = new Map();
    constructor() {
        super();
        // config.agentKeypair().secret() is the canonical way to obtain the signing secret.
        // Direct access to config.AGENT_SECRET_KEY is intentionally blocked by the AgentConfig
        // type (Omit<RawEnv, "AGENT_SECRET_KEY">); using agentKeypair() makes the access explicit.
        this.paymentTool = new StellarPaymentTool_1.StellarPaymentTool(config_1.config.agentKeypair().secret());
        this.sorobanTool = new SorobanInvokeTool_1.SorobanInvokeTool(config_1.config.agentKeypair().secret());
        this.x402Tool = new X402PaymentTool_1.X402PaymentTool(config_1.config.agentKeypair().secret());
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
    async waitForPendingTasks() {
        if (this.activeTasks === 0)
            return;
        logger_1.logger.info("Waiting for pending tasks to finish", { activeTasks: this.activeTasks });
        return new Promise((resolve) => {
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
        if (this.isDraining) {
            return {
                success: false,
                taskType: task.type,
                error: "Agent is shutting down — task rejected",
            };
        }
        this.activeTasks++;
        logger_1.logger.info("Running task", { taskType: task.type });
        try {
            let data;
            switch (task.type) {
                case "stellar_payment": {
                    const p = task.payload;
                    assertWithinSpendingLimit(p?.amount);
                    data = await this.paymentTool.execute(task.payload);
                    break;
                }
                case "soroban_invoke": {
                    data = await this.sorobanTool.execute(task.payload);
                    break;
                }
                case "x402_respond": {
                    const p = task.payload;
                    assertWithinSpendingLimit(p?.amount);
                    data = await this.x402Tool.respond(task.payload);
                    break;
                }
                default: {
                    const exhaustiveCheck = task.type;
                    throw new Error(`Unknown task type: ${exhaustiveCheck}`);
                }
            }
            logger_1.logger.info("Task completed", { taskType: task.type });
            const result = { success: true, taskType: task.type, data };
            this.emit("task:complete", result);
            return result;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Redact anything that looks like a secret key before logging
            const safe = message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
            logger_1.logger.error("Task failed", { taskType: task.type, error: safe });
            const result = { success: false, taskType: task.type, error: safe };
            this.emit("task:failed", result);
            return result;
        }
        finally {
            this.activeTasks--;
        }
    }
}
exports.PayFiAgent = PayFiAgent;
//# sourceMappingURL=agent.js.map