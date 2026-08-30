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

  /**
   * Return a snapshot of the current window state.
   *
   * @returns An object with:
   *   - `total` – cumulative spend within the active window
   *   - `recordCount` – number of records still within the window
   *   - `windowMs` – the configured window duration in milliseconds
   *   - `oldestTimestamp` – timestamp of the oldest in-window record, or `null` when empty
   */
  getWindowStatus(): {
    total: number;
    recordCount: number;
    windowMs: number;
    oldestTimestamp: number | null;
  } {
    const now = Date.now();
    this.pruneOld(now);
    return {
      total: this.records.reduce((sum, r) => sum + r.amount, 0),
      recordCount: this.records.length,
      windowMs: this.windowMs,
      oldestTimestamp: this.records.length > 0 ? this.records[0]!.timestamp : null,
    };
  }

  private pruneOld(now: number) {
    const cutoff = now - this.windowMs;
    while (this.records.length && this.records[0].timestamp < cutoff) {
      this.records.shift();
    }
  }
}
