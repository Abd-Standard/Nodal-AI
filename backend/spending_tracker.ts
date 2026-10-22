/**
 * backend/spending_tracker.ts
 *
 * Production-grade, atomic spending tracker with per-asset limits.
 *
 * Design goals (addresses GitHub issues #731–#734):
 *
 *   #731 — Rollback deletes the persisted row
 *     reserve() writes a row to SQLite.  rollback() deletes it by id.
 *     After a restart, restore() reloads only committed rows (rows still in DB
 *     because rollback already deleted them).
 *
 *   #732 — Atomic reservation prevents race condition
 *     reserve() is a synchronous critical section: the check and the push happen
 *     in a single tick with no await between them.  SQLite uses
 *     BEGIN IMMEDIATE for the DB write so a concurrent Node process cannot
 *     interleave.  The in-process lock (busy flag) prevents re-entrancy while
 *     the synchronous DB write is in flight.
 *
 *   #733 — Per-asset limits
 *     Each reservation carries an assetKey ("XLM" for native, "CODE:ISSUER" for
 *     credit assets).  Limits are looked up from config.SPENDING_LIMITS_MAP.
 *     Unknown assets are denied by default (config.SPENDING_LIMITS_ALLOW_UNKNOWN).
 *
 *   #734 — BigInt stroop arithmetic
 *     All amount comparisons and accumulation use toStroops() → BigInt to avoid
 *     IEEE-754 precision loss.  parseFloat is never used on monetary values.
 */

import { randomUUID } from "crypto";
import { config } from "./config";
import {
  saveSpendingRecord,
  deleteSpendingRecord,
  getSpendingRecordsSince,
  pruneSpendingRecords,
} from "./persistence";
import { toStroops, stroopsToString, STROOPS_PER_UNIT } from "./utils/amount";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SpendingEntry {
  readonly id: string;
  /** BigInt stroops — never a float. */
  readonly stroops: bigint;
  readonly assetKey: string;
  readonly timestampMs: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Derive a canonical asset key from an amount payload.
 *
 * For XLM (native): pass assetCode = "XLM", assetIssuer = undefined/""
 * For credit:       pass assetCode = "USDC", assetIssuer = "GA5Z…"
 *
 * Key format:
 *   - native → "XLM"
 *   - credit → "USDC:GA5Z…"
 */
export function assetKey(assetCode: string, assetIssuer?: string): string {
  const code = assetCode.trim().toUpperCase();
  if (!assetIssuer || code === "XLM") return "XLM";
  return `${code}:${assetIssuer.trim()}`;
}

/**
 * Look up the per-asset spending limit in stroops from config.
 * Falls back to the global AGENT_SPENDING_LIMIT when no per-asset entry exists.
 *
 * @returns The limit in stroops, or null when the asset is explicitly unknown
 *          and unknown assets are denied.
 */
function limitForAsset(key: string): bigint | null {
  const { SPENDING_LIMITS_MAP, SPENDING_LIMITS_ALLOW_UNKNOWN, AGENT_SPENDING_LIMIT } = config;

  if (SPENDING_LIMITS_MAP.size > 0) {
    const assetLimit = SPENDING_LIMITS_MAP.get(key);
    if (assetLimit !== undefined) {
      return toStroops(assetLimit);
    }
    // Asset not in map
    if (!SPENDING_LIMITS_ALLOW_UNKNOWN) {
      return null; // deny
    }
    // Fall through to global limit for unknown-but-allowed assets
  }

  // No per-asset config → use global limit
  return toStroops(AGENT_SPENDING_LIMIT);
}

// ─── SpendingTracker ──────────────────────────────────────────────────────────

/**
 * Thread-safe (single-process) spending tracker with:
 *   - Per-asset limits
 *   - Atomic reserve / commit / rollback
 *   - SQLite-backed persistence (survives restarts)
 *   - BigInt stroop arithmetic (no parseFloat on monetary values)
 */
export class SpendingTracker {
  private readonly windowMs: number;

  /** In-memory committed + reserved entries within the rolling window. */
  private readonly entries: SpendingEntry[] = [];

  /**
   * In-process mutual exclusion flag.  Because better-sqlite3 is synchronous,
   * reserve() is a true critical section: the check + push happen with no await
   * gap, making concurrent JS tasks serialised at this point.
   *
   * The flag exists to guard against re-entrant calls on the same tick (e.g. a
   * hook that calls reserve() inside a reserve() call chain).
   */
  private _reserving = false;
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
        logger.info(
          {
            records: this.records.length,
            total: this.total(),
          },
          'Restored spending window from persistence'
        );
      }
    } catch (err) {
      // No database, or it is unreadable — carry on with an empty window.
      logger.warn(
        {
          error: String(err),
        },
        'Could not restore spending window; starting empty'
      );
      this.records = [];
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Atomically reserve `amountStr` for `assetKey`.
   *
   * The check and the push are synchronous (no await between them), so
   * concurrent async tasks are naturally serialised in the JS event loop.
   * The SQLite write uses BEGIN IMMEDIATE, preventing interleave from another
   * Node process sharing the same DB file.
   *
   * @param amountStr - Strict decimal string (e.g. "100" or "9.9999999").
   * @param assetKeyStr - Canonical asset key from {@link assetKey()}.
   * @returns A reservation id to pass to commit() or rollback().
   * @throws When the amount is malformed, the asset is unknown/denied, or the
   *         limit would be exceeded.
   */
  reserve(amountStr: string, assetKeyStr: string): string {
    if (this._reserving) {
      throw new Error("SpendingTracker: re-entrant reserve() call detected");
    }
    this._reserving = true;
    try {
      return this._doReserve(amountStr, assetKeyStr);
    } finally {
      this._reserving = false;
    }
  }

  /**
   * Confirm that a previously reserved payment completed successfully.
   * The reservation stays in the in-memory window and the DB row remains until
   * it expires and is pruned.
   *
   * @param id - Reservation id returned by reserve().
   */
  commit(id: string): void {
    // Nothing to do in-memory — the entry is already tracked.
    // Optionally prune expired entries to keep the array compact.
    this._pruneOld(Date.now());
  }

  /**
   * Cancel a previously reserved payment (e.g. tool execution failed).
   *
   * Removes the reservation from the in-memory window AND deletes the
   * persisted DB row so it is not reloaded after a restart.
   *
   * @param id - Reservation id returned by reserve().
   */
  rollback(id: string): void {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx !== -1) {
      this.entries.splice(idx, 1);
    }
    // Delete the persisted row — this is the key fix for issue #731.
    deleteSpendingRecord(id);
  }

  /**
   * Return the total amount spent per asset within the current window.
   * Useful for the /spending endpoint.
   */
  totals(): Map<string, bigint> {
    const now = Date.now();
    this._pruneOld(now);
    const map = new Map<string, bigint>();
    for (const entry of this.entries) {
      map.set(entry.assetKey, (map.get(entry.assetKey) ?? 0n) + entry.stroops);
    }
    return map;
  }

  /**
   * Total stroops spent for a single asset within the current window.
   */
  totalForAsset(key: string): bigint {
    const now = Date.now();
    this._pruneOld(now);
    return this.entries
      .filter((e) => e.assetKey === key)
      .reduce((sum, e) => sum + e.stroops, 0n);
  }

  /**
   * Restore persisted spending records from the DB into the in-memory window.
   * Call once at process startup before accepting tasks.
   */
  restore(): void {
    const cutoffMs = Date.now() - this.windowMs;
    const cutoffIso = new Date(cutoffMs).toISOString();
    const rows = getSpendingRecordsSince(cutoffIso);
    for (const row of rows) {
      let stroops: bigint;
      try {
        stroops = toStroops(row.amount);
      } catch {
        // Row has malformed amount — skip rather than crash on restart
        continue;
      }
      this.entries.push({
        id: row.id,
        stroops,
        assetKey: row.assetKey,
        timestampMs: new Date(row.timestamp).getTime(),
      });
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
        logger.warn(
          {
            total,
            limit,
            percent: ((total / limit) * 100).toFixed(1),
          },
          'Approaching spending limit'
        );
      }
      if (total > limit) {
        throw new Error(`Cumulative spending ${total} exceeds limit ${limit}`);
      }
    }
    // Prune any DB rows older than the window (they were committed before the
    // last restart but are now outside the rolling window).
    pruneSpendingRecords(cutoffIso);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private _doReserve(amountStr: string, assetKeyStr: string): string {
    // 1. Parse amount — throws on invalid format (no parseFloat)
    const stroops = toStroops(amountStr);

    // 2. Look up limit — null means asset is denied
    const limit = limitForAsset(assetKeyStr);
    if (limit === null) {
      throw new Error(
        `Asset "${assetKeyStr}" is not in the per-asset spending limits and ` +
        `SPENDING_LIMITS_ALLOW_UNKNOWN is false — payment denied`
      );
    }

    // 3. Check single-payment mainnet cap FIRST (belt-and-suspenders, fast path)
    if (config.STELLAR_NETWORK === "mainnet") {
      const capStroops = BigInt(10_000) * STROOPS_PER_UNIT; // 10_000 units
      if (stroops > capStroops) {
        throw new Error(
          `Payment amount ${amountStr} ${assetKeyStr} exceeds ` +
          `mainnet spending cap of 10000`
        );
      }
    }

    const now = Date.now();
    this._pruneOld(now);

    // 4. Check cumulative limit BEFORE pushing (atomic check-then-act)
    const current = this.totalForAsset(assetKeyStr);
    const newTotal = current + stroops;

    if (newTotal > limit) {
      throw new Error(
        `Cumulative spending for ${assetKeyStr} would reach ` +
        `${stroopsToString(newTotal)} (limit: ${stroopsToString(limit)})`
      );
    }

    // 4. Persist reservation BEFORE pushing to in-memory (atomic with SQLite BEGIN IMMEDIATE)
    const id = randomUUID();
    const timestamp = new Date(now).toISOString();
    const amountNorm = stroopsToString(stroops); // canonical 7-decimal form

    saveSpendingRecord({ id, timestamp, amount: amountNorm, assetKey: assetKeyStr });

    // 5. Push to in-memory entries — limit was checked just above with no await gap
    this.entries.push({ id, stroops, assetKey: assetKeyStr, timestampMs: now });

    return id;
  }

  private _pruneOld(now: number): void {
    const cutoff = now - this.windowMs;
    // entries are in insertion order; prune from the front
    while (this.entries.length > 0 && (this.entries[0]?.timestampMs ?? 0) < cutoff) {
      this.entries.shift();
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
      logger.warn({ error: String(err) }, 'Could not persist spending record');
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

  /**
   * Clear all in-memory entries.
   * FOR TESTING ONLY — resets state between tests without requiring a new instance.
   * @internal
   */
  _resetForTests(): void {
    this.entries.splice(0);
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
