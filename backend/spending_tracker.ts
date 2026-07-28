import { config } from "./config";

/**
 * Simple in‑memory spending tracker that records each payment amount and
 * maintains a rolling time window. It is used by the agent to enforce a
 * cumulative spending limit within `config.SPENDING_WINDOW_MS`.
 */
export class SpendingTracker {
  private readonly windowMs: number;
  private readonly records: { amount: number; timestamp: number }[] = [];

  constructor(windowMs: number = config.SPENDING_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Record a payment amount. The amount is expected to be a numeric string.
   * Throws if the new cumulative total exceeds `config.AGENT_SPENDING_LIMIT`.
   */
  record(amountStr: string) {
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) return; // let callers handle invalid input
    const now = Date.now();
    this.pruneOld(now);
    this.records.push({ amount, timestamp: now });
    const total = this.total();
    const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
    if (!isNaN(total) && !isNaN(limit) && total > limit) {
      throw new Error(`Cumulative spending ${total} exceeds limit ${limit}`);
    }
  }

  /** Return the total amount spent within the current window. */
  total(): number {
    const now = Date.now();
    this.pruneOld(now);
    return this.records.reduce((sum, r) => sum + r.amount, 0);
  }

  private pruneOld(now: number) {
    const cutoff = now - this.windowMs;
    while (this.records.length && this.records[0].timestamp < cutoff) {
      this.records.shift();
    }
  }

  clear() {
    this.records = [];
  }
}
