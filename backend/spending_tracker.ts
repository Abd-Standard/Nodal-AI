/**
 * backend/spending_tracker.ts
 *
 * Production-grade spending tracker with:
 *
 * Issue #734 — BigInt/stroop arithmetic (no parseFloat on monetary values).
 * Issue #733 — Per-asset limits (SPENDING_LIMITS config) with unknown-asset denial.
 * Issue #732 — Atomic reservation (check-and-reserve in a single synchronous
 *              critical section) preventing concurrent over-spend.
 * Issue #731 — rollback() physically deletes the persisted row so a restart does
 *              not re-load it.
 *
 * The tracker exposes:
 *   reserve(id, assetCode, issuer?, amountStr) — check + reserve atomically
 *   commit(id)                                 — finalise a reservation
 *   rollback(id)                               — cancel + delete persisted row
 *   totalStroops(assetCode, issuer?)           — current window total in stroops
 *   report()                                   — per-asset usage summary
 */

import { config } from "./config";
import type { AssetSpendingLimit } from "./config";
import { toStroops, fromStroops } from "./utils/amount";
import {
  saveSpendingRecord,
  deleteSpendingRecord,
  pruneSpendingRecords,
  restoreSpendingRecords,
} from "./persistence";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Canonical key used to bucket records by asset (code + optional issuer). */
function assetKey(assetCode: string, issuer?: string): string {
  return issuer ? `${assetCode}:${issuer}` : assetCode;
}

/** Find the configured limit for a given asset, or undefined if not found. */
function findLimit(
  limits: AssetSpendingLimit[],
  assetCode: string,
  issuer?: string
): AssetSpendingLimit | undefined {
  return limits.find(
    (l) =>
      l.assetCode === assetCode &&
      (l.issuer === undefined || l.issuer === issuer)
  );
}

// ─── In-process mutex (single-process atomicity) ──────────────────────────────

/**
 * A tiny async mutex that serialises concurrent reserve() calls so the
 * check-then-act is never interleaved across concurrent async tasks.
 *
 * For multi-process deployments the caller should use SQLite BEGIN IMMEDIATE
 * transactions (or equivalent) around saveSpendingRecord + deleteSpendingRecord.
 * Within a single Node.js process this mutex is sufficient because JavaScript
 * is single-threaded — no two continuations run simultaneously.
 */
class Mutex {
  private _queue: Array<() => void> = [];
  private _locked = false;

  async acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const tryAcquire = () => {
        if (!this._locked) {
          this._locked = true;
          resolve(() => this._release());
        } else {
          this._queue.push(tryAcquire);
        }
      };
      tryAcquire();
    });
  }

  private _release(): void {
    this._locked = false;
    const next = this._queue.shift();
    if (next) next();
  }
}

// ─── SpendingRecord (in-memory) ───────────────────────────────────────────────

interface InMemoryRecord {
  id: string;
  assetCode: string;
  issuer?: string;
  stroops: bigint;
  timestamp: number;
  /** pending = reserved but not yet committed; committed = finalised */
  state: "pending" | "committed";
}

// ─── SpendingTracker ──────────────────────────────────────────────────────────

/**
 * Thread-safe (within a single Node.js process) spending tracker.
 *
 * Usage:
 *   const release = await tracker.reserve("req-1", "XLM", undefined, "10");
 *   // ... execute the payment ...
 *   tracker.commit("req-1");  // on success
 *   // OR
 *   tracker.rollback("req-1"); // on failure
 */
export class SpendingTracker {
  private readonly windowMs: number;
  private readonly records: Map<string, InMemoryRecord> = new Map();
  private readonly mutex = new Mutex();

  constructor(windowMs: number = config.SPENDING_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  // ── Restore persisted records on startup ────────────────────────────────────

  /**
   * Load committed spending records from SQLite into memory.
   * Call once at agent startup before accepting tasks.
   */
  restore(): void {
    const cutoff = Date.now() - this.windowMs;
    const rows = restoreSpendingRecords(cutoff);
    for (const row of rows) {
      this.records.set(row.id, {
        id:        row.id,
        assetCode: row.assetCode,
        issuer:    row.issuer,
        stroops:   BigInt(row.stroops),
        timestamp: row.timestamp,
        state:     "committed",
      });
    }
  }

  // ── Core atomic reservation ──────────────────────────────────────────────────

  /**
   * Atomically check the spending limit and reserve the amount.
   *
   * The entire check-and-insert is protected by an async mutex so concurrent
   * calls cannot both pass the limit check before either is recorded.
   *
   * @param id        - Unique reservation identifier (e.g. correlation ID).
   * @param assetCode - Stellar asset code (e.g. "XLM", "USDC").
   * @param issuer    - Issuer G-address for non-native assets; undefined for XLM.
   * @param amountStr - Amount string (strict decimal, max 7 places).
   *
   * @throws {Error} If the amount would exceed the configured limit.
   * @throws {Error} If the asset is not in the per-asset limits and per-asset
   *                 mode is active (unknown assets are denied by default).
   * @throws {Error} If the amount string is not a valid Stellar amount.
   */
  async reserve(
    id: string,
    assetCode: string,
    issuer: string | undefined,
    amountStr: string
  ): Promise<void> {
    // Parse + validate amount eagerly (outside the lock) so malformed strings
    // throw without acquiring the mutex.
    const stroops = toStroops(amountStr);
    const key = assetKey(assetCode, issuer);
    const now = Date.now();

    const release = await this.mutex.acquire();
    try {
      this._pruneOld(now);

      const limits = config.SPENDING_LIMITS;

      if (limits.length > 0) {
        // Per-asset mode ─────────────────────────────────────────────────────
        const limitEntry = findLimit(limits, assetCode, issuer);
        if (!limitEntry) {
          throw new Error(
            `Payment denied: asset "${key}" is not in the configured SPENDING_LIMITS. ` +
              `Unknown assets are rejected by default.`
          );
        }
        const limitStroops = toStroops(limitEntry.limit);
        const currentTotal = this._totalStroops(assetCode, issuer, now);
        if (currentTotal + stroops > limitStroops) {
          throw new Error(
            `Cumulative spending for ${key} would be ${fromStroops(currentTotal + stroops)}, ` +
              `exceeding the configured limit of ${limitEntry.limit}.`
          );
        }
      } else {
        // Single global limit mode ────────────────────────────────────────────
        const limitStroops = toStroops(config.AGENT_SPENDING_LIMIT);
        // Global total across all assets (legacy behaviour)
        const currentTotal = this._totalAllStroops(now);
        if (currentTotal + stroops > limitStroops) {
          throw new Error(
            `Cumulative spending ${fromStroops(currentTotal + stroops)} exceeds ` +
              `AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}.`
          );
        }
      }

      // Reserve the amount — pending until commit() or rollback()
      const record: InMemoryRecord = {
        id,
        assetCode,
        issuer,
        stroops,
        timestamp: now,
        state: "pending",
      };
      this.records.set(id, record);

      // Persist immediately so that if the process crashes mid-payment the
      // reserved spend is not silently lost. (rollback() will delete it.)
      saveSpendingRecord({
        id,
        assetCode,
        issuer,
        stroops:   stroops.toString(),
        timestamp: now,
      });
    } finally {
      release();
    }
  }

  /**
   * Mark a reservation as committed (finalised).
   * The persisted row remains — it will expire naturally after windowMs.
   *
   * @param id - The reservation identifier passed to reserve().
   */
  commit(id: string): void {
    const record = this.records.get(id);
    if (!record) return; // idempotent
    record.state = "committed";
  }

  /**
   * Roll back a reservation — removes the in-memory record AND deletes the
   * persisted row so a restart does not reload it.
   *
   * Fix for Issue #731: previous implementation only pruned expired rows,
   * so rolled-back records survived restart.
   *
   * @param id - The reservation identifier passed to reserve().
   */
  rollback(id: string): void {
    if (!this.records.has(id)) return; // idempotent
    this.records.delete(id);
    deleteSpendingRecord(id); // ← physically removes the row (Issue #731 fix)
  }

  // ── Query helpers ─────────────────────────────────────────────────────────

  /** Expose windowMs for external consumers (e.g. the /spending HTTP endpoint). */
  getWindowMs(): number {
    return this.windowMs;
  }

  /**
   * Current window total in stroops for a specific asset.
   * Includes both pending and committed records.
   */
  totalStroops(assetCode: string, issuer?: string): bigint {
    const now = Date.now();
    this._pruneOld(now);
    return this._totalStroops(assetCode, issuer, now);
  }

  /**
   * Per-asset usage report for the /spending endpoint.
   *
   * Returns an array of objects: { asset, total, limit, remaining }.
   */
  report(): Array<{
    asset:     string;
    total:     string;
    limit:     string;
    remaining: string;
  }> {
    const now = Date.now();
    this._pruneOld(now);

    const limits = config.SPENDING_LIMITS;

    if (limits.length > 0) {
      return limits.map((l) => {
        const key = assetKey(l.assetCode, l.issuer);
        const totalStr = fromStroops(this._totalStroops(l.assetCode, l.issuer, now));
        const limitStroops = toStroops(l.limit);
        const totalStroopsVal = toStroops(totalStr);
        const remainingStroops =
          totalStroopsVal >= limitStroops ? 0n : limitStroops - totalStroopsVal;
        return {
          asset:     key,
          total:     totalStr,
          limit:     l.limit,
          remaining: fromStroops(remainingStroops),
        };
      });
    }

    // Single global limit
    const totalStroopsVal = this._totalAllStroops(now);
    const totalStr = fromStroops(totalStroopsVal);
    const limitStroops = toStroops(config.AGENT_SPENDING_LIMIT);
    const remainingStroops =
      totalStroopsVal >= limitStroops ? 0n : limitStroops - totalStroopsVal;

    return [
      {
        asset:     config.X402_ASSET_CODE,
        total:     totalStr,
        limit:     config.AGENT_SPENDING_LIMIT,
        remaining: fromStroops(remainingStroops),
      },
    ];
  }

  // ── Legacy synchronous API (used by agent.ts assertWithinSpendingLimit) ──────
  // Retained for backwards compatibility. Prefer reserve()/commit()/rollback().

  /**
   * @deprecated Use reserve() / commit() / rollback() for atomic, per-asset
   *             and BigInt-safe spending control.
   *
   * Synchronous record for the single-asset legacy path.
   * Throws if the new cumulative total would exceed the global limit.
   */
  record(amountStr: string): void {
    const stroops = toStroops(amountStr);
    const now = Date.now();
    this._pruneOld(now);

    const limitStroops = toStroops(config.AGENT_SPENDING_LIMIT);
    const currentTotal = this._totalAllStroops(now);
    if (currentTotal + stroops > limitStroops) {
      throw new Error(
        `Cumulative spending ${fromStroops(currentTotal + stroops)} exceeds ` +
          `limit ${config.AGENT_SPENDING_LIMIT}`
      );
    }

    const id = `sync-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const record: InMemoryRecord = {
      id,
      assetCode: config.X402_ASSET_CODE,
      issuer:    undefined,
      stroops,
      timestamp: now,
      state:     "committed",
    };
    this.records.set(id, record);
    saveSpendingRecord({
      id,
      assetCode: config.X402_ASSET_CODE,
      issuer:    undefined,
      stroops:   stroops.toString(),
      timestamp: now,
    });
  }

  /** Total stroops in the window across all assets (legacy global mode). */
  total(): bigint {
    const now = Date.now();
    this._pruneOld(now);
    return this._totalAllStroops(now);
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private _pruneOld(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [id, rec] of this.records) {
      if (rec.timestamp < cutoff) {
        this.records.delete(id);
      }
    }
    pruneSpendingRecords(cutoff);
  }

  private _totalStroops(
    assetCode: string,
    issuer: string | undefined,
    _now: number
  ): bigint {
    let sum = 0n;
    for (const rec of this.records.values()) {
      if (rec.assetCode === assetCode && rec.issuer === issuer) {
        sum += rec.stroops;
      }
    }
    return sum;
  }

  private _totalAllStroops(_now: number): bigint {
    let sum = 0n;
    for (const rec of this.records.values()) {
      sum += rec.stroops;
    }
    return sum;
  }
}
