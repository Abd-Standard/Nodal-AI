import { config } from "./config";

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

  constructor(windowMs: number = config.SPENDING_WINDOW_MS) {
    this.windowMs = windowMs;
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
    while (this.records.length > 0) {
      const first = this.records[0];
      if (first && first.timestamp < cutoff) {
        this.records.shift();
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
  }
}
