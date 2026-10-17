import { config } from './config';
import { logger } from './logger';
import {
  clearSpendingRecords,
  loadSpendingRecords,
  pruneSpendingRecords,
  saveSpendingRecord,
} from './persistence';

/**
 * Simple in‑memory spending tracker that records each payment amount and
 * maintains a rolling time window. It is used by the agent to enforce a
 * cumulative spending limit within `config.SPENDING_WINDOW_MS`.
 *
 * ## Record semantics (issue #730)
 * `record()` computes the prospective total *before* mutating state. If adding
 * the new amount would breach the limit the method throws *without* pushing the
 * record. A rejected attempt therefore leaves `total()` unchanged and nothing
 * is persisted.
 *
 * ## Reserve / commit / release semantics (issue #729)
 * For transaction-submission flows where the outcome is unknown at call-time,
 * use the three-phase API instead of `record()`:
 *
 *   1. `reserve(amount)` → `reservationId`   – holds the amount against the
 *      limit; throws if it would be exceeded.  State is provisional until
 *      the reservation is either committed or released.
 *   2. `commit(id)`                           – confirms a successful
 *      submission; converts the provisional hold into a real record.
 *   3. `release(id)`                          – cancels a failed/rejected
 *      submission; removes the hold so the amount is not counted.
 *
 * A reservation that is neither committed nor released keeps the amount
 * reserved inside the current window (conservative-safe behaviour on crash).
 */
export class SpendingTracker {
  private readonly windowMs: number;
  // Real committed records (issue #730 – never contains rejected amounts)
  private records: { amount: number; timestamp: number }[] = [];
  // Provisional holds – reserved but not yet committed or released (issue #729)
  private reservations: Map<string, { amount: number; timestamp: number }> = new Map();
  private nextReservationId = 0;
 * Spending tracker that records each payment amount and maintains a rolling
 * time window. It is used by the agent to enforce a cumulative spending limit
 * within `config.SPENDING_WINDOW_MS`.
 *
 * The window is mirrored to SQLite (#372). Holding it only in memory meant a
 * restart reset the cumulative total to zero, so an agent that was restarted —
 * or that crashed and was restarted for it — could spend past its cap by
 * starting over with a clean slate. Records are reloaded on construction and
 * written on every `record()`.
 *
 * Persistence is best-effort: if the database is unavailable the tracker still
 * enforces the limit for the life of the process rather than refusing to run.
 */
export class SpendingTracker {
  private readonly windowMs: number;
  private records: { amount: number; timestamp: number }[] = [];

  constructor(windowMs: number = config.SPENDING_WINDOW_MS) {
    this.windowMs = windowMs;
    this.restore();
  }

  /**
   * Load the unexpired part of the window left behind by a previous process.
   */
  private restore(): void {
    const cutoff = Date.now() - this.windowMs;
    try {
      this.records = loadSpendingRecords(cutoff).map((r) => ({
        amount: r.amount,
        timestamp: r.timestamp,
      }));
      if (this.records.length > 0) {
        logger.info('Restored spending window from persistence', {
          records: this.records.length,
          total: this.total(),
        });
      }
    } catch (err) {
      // No database, or it is unreadable — carry on with an empty window.
      logger.warn('Could not restore spending window; starting empty', {
        error: String(err),
      });
      this.records = [];
    }
  }

  // ─── Issue #730: check-before-push ──────────────────────────────────────────

  /**
   * Record a payment amount immediately (no reserve/commit needed).
   * The amount is expected to be a numeric string.
   *
   * **Fix for #730**: the prospective total is computed *before* the record is
   * pushed. If it would exceed the limit the method throws without mutating
   * state — a rejected call leaves `total()` unchanged.
   *
   * @throws if the new cumulative total would exceed `config.AGENT_SPENDING_LIMIT`.
   * Record a payment amount. The amount is expected to be a numeric string.
   * Throws if the new cumulative total exceeds `config.AGENT_SPENDING_LIMIT`.
   *
   * Callers must only invoke this once a transfer has actually been submitted
   * successfully — recording before submission permanently counts a spend that
   * may never have happened (see #646).
   */
  record(amountStr: string): void {
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) return; // let callers handle invalid input
    const now = Date.now();
    this.pruneOld(now);

    // ── #730 fix: check BEFORE mutating ──────────────────────────────────────
    const prospective = this.sumCommitted() + this.sumReserved() + amount;
    const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
    if (!isNaN(prospective) && !isNaN(limit) && prospective > limit) {
      // Throw without pushing — rejected amount never enters state
      throw new Error(`Cumulative spending ${prospective} exceeds limit ${limit}`);
    }

    this.records.push({ amount, timestamp: now });
  }

  // ─── Issue #729: reserve / commit / release ───────────────────────────────

  /**
   * Reserve an amount against the spending limit before submitting a
   * transaction.  Returns a `reservationId` that must later be passed to
   * either `commit()` (on success) or `release()` (on failure).
   *
   * The reserved amount counts against the limit immediately so that
   * concurrent reservations cannot collectively exceed it.
   *
   * @throws if the prospective total (committed + all current holds + amount)
   *   would exceed `config.AGENT_SPENDING_LIMIT`.
   */
  reserve(amountStr: string): string {
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) {
      throw new Error(`reserve() requires a valid numeric amount; got "${amountStr}"`);
    }
    const now = Date.now();
    this.pruneOld(now);

    const prospective = this.sumCommitted() + this.sumReserved() + amount;
    const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
    if (!isNaN(prospective) && !isNaN(limit) && prospective > limit) {
      throw new Error(`Cumulative spending ${prospective} exceeds limit ${limit}`);
    this.persist({ amount, timestamp: now });
    const total = this.total();
    const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
    if (!isNaN(total) && !isNaN(limit)) {
      if (total > limit * 0.8) {
        logger.warn('Approaching spending limit', {
          total,
          limit,
          percent: ((total / limit) * 100).toFixed(1),
        });
      }
      if (total > limit) {
        throw new Error(`Cumulative spending ${total} exceeds limit ${limit}`);
      }
    }
  }

  /**
   * Undo a previously recorded amount, used to roll back a spend that was
   * recorded but whose transaction ultimately failed to submit (#646).
   *
   * Removes the most recent record matching `amountStr` within the active
   * window and deletes it from persistence. Best-effort: a missing record is a
   * no-op so callers can safely invoke this from a failure path.
   */
  rollback(amountStr: string): void {
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) return;
    const now = Date.now();
    this.pruneOld(now);
    for (let i = this.records.length - 1; i >= 0; i--) {
      const rec = this.records[i];
      if (rec && rec.amount === amount) {
        this.records.splice(i, 1);
        try {
          pruneSpendingRecords(now - this.windowMs);
        } catch {
          // Persistence is best-effort; the in-memory window is authoritative.
        }
        return;
      }
    }

    const id = String(this.nextReservationId++);
    this.reservations.set(id, { amount, timestamp: now });
    return id;
  }

  /**
   * Commit a previously reserved amount after a successful transaction
   * submission.  The provisional hold is converted into a real record so it
   * continues to count within the window.
   *
   * @throws if `id` does not correspond to an active reservation.
   */
  commit(id: string): void {
    const reservation = this.reservations.get(id);
    if (!reservation) {
      throw new Error(`No active reservation with id "${id}"`);
    }
    this.reservations.delete(id);
    // Preserve the original reservation timestamp so the window boundary is
    // calculated relative to when the payment was authorised, not submitted.
    this.records.push({ amount: reservation.amount, timestamp: reservation.timestamp });
  }

  /**
   * Release (roll back) a reservation after a failed transaction submission.
   * The amount is removed so that it does not count against the limit.
   *
   * @throws if `id` does not correspond to an active reservation.
   */
  release(id: string): void {
    if (!this.reservations.has(id)) {
      throw new Error(`No active reservation with id "${id}"`);
    }
    this.reservations.delete(id);
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  /** Return the total committed amount within the current window. */
  total(): number {
    const now = Date.now();
    this.pruneOld(now);
    return this.sumCommitted();
  }

  /** Return the total of committed + reserved amounts within the current window. */
  totalWithReserved(): number {
    const now = Date.now();
    this.pruneOld(now);
    return this.sumCommitted() + this.sumReserved();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private sumCommitted(): number {
    return this.records.reduce((sum, r) => sum + r.amount, 0);
    return this.calculateTotal();
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
      total: this.calculateTotal(),
      recordCount: this.records.length,
      windowMs: this.windowMs,
      oldestTimestamp: this.records.length > 0 ? this.records[0]!.timestamp : null,
    };
  }

  /**
   * Calculate cumulative spending sum using BigInt stroop scaling (10_000_000n)
   * to avoid floating-point addition rounding error accumulation across records.
   */
  private calculateTotal(): number {
    const STROOP_SCALE = 10_000_000n;
    const totalStroops = this.records.reduce((sum, r) => {
      const str = r.amount.toFixed(7);
      const [whole = '0', fraction = ''] = str.split('.');
      const wholeBig = BigInt(whole);
      const fracBig = BigInt(fraction.padEnd(7, '0').slice(0, 7));
      const stroops = wholeBig < 0n || str.startsWith('-')
        ? wholeBig * STROOP_SCALE - fracBig
        : wholeBig * STROOP_SCALE + fracBig;
      return sum + stroops;
    }, 0n);
    return Number(totalStroops) / Number(STROOP_SCALE);
  }

  private persist(record: { amount: number; timestamp: number }): void {
    try {
      saveSpendingRecord(record);
    } catch (err) {
      // A spend that cannot be written down still counts in this process.
      logger.warn('Could not persist spending record', { error: String(err) });
    }
  }

  private sumReserved(): number {
    let sum = 0;
    for (const r of this.reservations.values()) {
      sum += r.amount;
    }
    return sum;
  }

  private pruneOld(now: number): void {
    const cutoff = now - this.windowMs;
    // Prune committed records
    let evicted = false;
    while (this.records.length > 0) {
      const first = this.records[0];
      if (first && first.timestamp < cutoff) {
        this.records.shift();
        evicted = true;
      } else {
        break;
      }
    }
    // Prune stale reservations (conservative: only remove when strictly expired)
    for (const [id, r] of this.reservations.entries()) {
      if (r.timestamp < cutoff) {
        this.reservations.delete(id);
      }
    }
  }

  /** Reset all state (committed records and reservations). */
  clear(): void {
    // Fix for #730: records was declared readonly, which caused a compile error
    // when reassigning. Use splice/clear instead of reassignment.
    this.records.splice(0);
    this.reservations.clear();
    if (evicted) {
      try {
        pruneSpendingRecords(cutoff);
      } catch {
        // Pruning is housekeeping; failing to do it must not block a payment.
      }
    }
  }

  clear() {
    this.records.length = 0;
    this.records = [];
    try {
      clearSpendingRecords();
    } catch {
      // Nothing persisted to clear.
    }
  }
}

/**
 * Process-wide singleton backing the cumulative spending window.
 *
 * Lives here (not in agent.ts) so value-moving tools — e.g.
 * {@link tools/SorobanInvokeTool!SorobanInvokeTool | SorobanInvokeTool} — can record simulated SAC transfers against the
 * same window as payments without importing the agent (which would create a
 * module cycle) or instantiating a second tracker (whose in-memory state would
 * drift from the real one).
 */
export const spendingTracker = new SpendingTracker();
