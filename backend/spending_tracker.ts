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

  constructor(windowMs: number = config.SPENDING_WINDOW_MS) {
    this.windowMs = windowMs;
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
