/**
 * Simple in‑memory spending tracker that records each payment amount and
 * maintains a rolling time window. It is used by the agent to enforce a
 * cumulative spending limit within `config.SPENDING_WINDOW_MS`.
 */
export declare class SpendingTracker {
    private readonly windowMs;
    private records;
    constructor(windowMs?: number);
    /**
     * Record a payment amount. The amount is expected to be a numeric string.
     * Throws if the new cumulative total exceeds `config.AGENT_SPENDING_LIMIT`.
     */
    record(amountStr: string): void;
    /** Return the total amount spent within the current window. */
    total(): number;
    private pruneOld;
    clear(): void;
}
//# sourceMappingURL=spending_tracker.d.ts.map