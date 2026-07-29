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
import { rpc } from "@stellar/stellar-sdk";
import { X402Challenge } from "./tools/X402PaymentTool";
import { SpendingTracker } from "./spending_tracker";
export declare const spendingTracker: SpendingTracker;
export type TaskType = "stellar_payment" | "soroban_invoke" | "soroban_query" | "x402_respond" | "account_info" | "change_trust" | "multisig_payment" | "batch_payment" | "balance_check" | "path_payment" | "fee_bump" | "dex_offer";
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
export type TaskMiddleware = (task: AgentTask, next: () => Promise<AgentResult>) => Promise<AgentResult>;
export declare class PayFiAgent extends EventEmitter {
    private paymentTool;
    private sorobanTool;
    private sorobanQueryTool;
    private x402Tool;
    private accountInfoTool;
    private trustlineTool;
    private multiSigTool;
    private batchPaymentTool;
    private balanceCheckTool;
    private pathPaymentTool;
    private feeBumpTool;
    private dexOfferTool;
    private activeTasks;
    private isDraining;
    private readonly taskQueue;
    private _streamStop;
    private _contractListenerStop;
    private readonly _boundHandlers;
    private middlewares;
    constructor();
    /**
     * Start polling the Horizon payment stream for incoming x402 challenges.
     * Calls onChallenge for each payment whose memo starts with "x402:".
     */
    startListening(resourceUrl: string, onChallenge: (challenge: X402Challenge) => void): void;
    /** Stop the active Horizon payment stream subscription. */
    stopListening(): void;
    /**
     * Start polling a Soroban contract for events.
     * Calls onEvent for each new event matching the provided eventTypes filter.
     * Pass an empty array for eventTypes to receive all contract events.
     *
     * @param contractId - The Stellar contract ID to monitor.
     * @param eventTypes - Topic strings to filter by (empty array = all events).
     * @param onEvent    - Callback invoked for each matching event.
     */
    startContractListener(contractId: string, eventTypes: string[], onEvent: (event: rpc.Api.EventResponse) => void): void;
    /** Stop the active contract event listener. */
    stopContractListener(): void;
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
    destroy(): void;
    drain(): void;
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
    use(middleware: TaskMiddleware): void;
    waitForPendingTasks(): Promise<void>;
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
    runSequence(tasks: AgentTask[]): Promise<AgentResult[]>;
    /** Dispatch a task to the correct tool */
    run(task: AgentTask): Promise<AgentResult>;
    /**
     * Pull the next queued task (if any) and dispatch it once a concurrency
     * slot frees up. Called from executeTask()'s `finally` block.
     */
    private dispatchQueued;
    /** Run a task's tool logic — assumes the concurrency slot has already been reserved. */
    private executeTask;
}
//# sourceMappingURL=agent.d.ts.map