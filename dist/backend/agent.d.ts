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
export type TaskType = "stellar_payment" | "soroban_invoke" | "x402_respond";
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
export declare class PayFiAgent extends EventEmitter {
    private paymentTool;
    private sorobanTool;
    private x402Tool;
    private activeTasks;
    private isDraining;
    private readonly _boundHandlers;
    constructor();
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
}
//# sourceMappingURL=agent.d.ts.map