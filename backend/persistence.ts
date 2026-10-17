/**
 * backend/persistence.ts
 *
 * SQLite-backed storage for:
 *   1. agent_results — audit log for every AgentResult produced by PayFiAgent.run().
 *   2. spending_records — rolling window of reserved/committed payments used by
 *      SpendingTracker for cross-restart persistence.
 *
 * The DB path is configured via DB_PATH (default: ./agent.db).
 * Pass ":memory:" for in-process testing via _setDb().
 *
 * Issues addressed:
 *   #731 — deleteSpendingRecord() physically removes rolled-back rows so they
 *           do not reappear after restart.
 *   #732 — saveSpendingRecord() uses a synchronous SQLite write (better-sqlite3
 *           is always synchronous), acting as part of the in-process atomic
 *           critical section in SpendingTracker.
 */

import Database from "better-sqlite3";
import type { AgentResult } from "./agent";

export type PersistedResult = AgentResult & { timestamp: string };

/** Shape of a row in the spending_records table. */
export interface SpendingRecord {
  /** Unique reservation identifier — matches the id passed to SpendingTracker.reserve(). */
  id:        string;
  /** Stellar asset code (e.g. "XLM", "USDC"). */
  assetCode: string;
  /** Issuer G-address for non-native assets; undefined/null for XLM. */
  issuer?:   string;
  /** Amount in stroops expressed as a string to preserve BigInt precision. */
  stroops:   string;
  /** Unix epoch ms when the reservation was created. */
  timestamp: number;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    // Lazy import of config so that tests can inject via _setDb() before any DB access
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require("./config") as typeof import("./config");
    _db = new Database(config.DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_results (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT    NOT NULL,
        taskType  TEXT    NOT NULL,
        success   INTEGER NOT NULL,
        data      TEXT,
        error     TEXT
      );

      CREATE TABLE IF NOT EXISTS spending_records (
        id        TEXT    PRIMARY KEY,
        assetCode TEXT    NOT NULL,
        issuer    TEXT,
        stroops   TEXT    NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
  }
  return _db;
}

// ─── agent_results ────────────────────────────────────────────────────────────

export function saveResult(result: PersistedResult): void {
  getDb()
    .prepare(
      `INSERT INTO agent_results (timestamp, taskType, success, data, error)
       VALUES (@timestamp, @taskType, @success, @data, @error)`
    )
    .run({
      timestamp: result.timestamp,
      taskType:  result.taskType,
      success:   result.success ? 1 : 0,
      data:      result.data !== undefined ? JSON.stringify(result.data) : null,
      error:     result.error ?? null,
    });
}

export function getResults(limit = 100): PersistedResult[] {
  const rows = getDb()
    .prepare(
      `SELECT timestamp, taskType, success, data, error
       FROM agent_results ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as Array<{
      timestamp: string;
      taskType:  string;
      success:   number;
      data:      string | null;
      error:     string | null;
    }>;

  return rows.map((r) => ({
    timestamp: r.timestamp,
    taskType:  r.taskType as AgentResult["taskType"],
    success:   r.success === 1,
    data:      r.data !== null ? JSON.parse(r.data) : undefined,
    error:     r.error ?? undefined,
  }));
}

// ─── spending_records ─────────────────────────────────────────────────────────

/**
 * Persist a new spending reservation.
 * Called synchronously inside SpendingTracker's mutex-protected critical section.
 * (better-sqlite3 execute methods are always synchronous.)
 */
export function saveSpendingRecord(record: SpendingRecord): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO spending_records (id, assetCode, issuer, stroops, timestamp)
       VALUES (@id, @assetCode, @issuer, @stroops, @timestamp)`
    )
    .run({
      id:        record.id,
      assetCode: record.assetCode,
      issuer:    record.issuer ?? null,
      stroops:   record.stroops,
      timestamp: record.timestamp,
    });
}

/**
 * Physically delete a spending record by id.
 *
 * Issue #731 fix: rollback() must call this so the row is gone from SQLite
 * and cannot be re-loaded by restore() after a process restart.
 */
export function deleteSpendingRecord(id: string): void {
  getDb()
    .prepare(`DELETE FROM spending_records WHERE id = ?`)
    .run(id);
}

/**
 * Delete all spending records older than the given Unix epoch ms cutoff.
 * Called by SpendingTracker._pruneOld() on every operation.
 */
export function pruneSpendingRecords(cutoffMs: number): void {
  getDb()
    .prepare(`DELETE FROM spending_records WHERE timestamp < ?`)
    .run(cutoffMs);
}

/**
 * Load all spending records newer than cutoffMs from SQLite.
 * Used by SpendingTracker.restore() at startup.
 *
 * @param cutoffMs - Exclude records older than this Unix epoch ms.
 */
export function restoreSpendingRecords(cutoffMs: number): SpendingRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT id, assetCode, issuer, stroops, timestamp
       FROM spending_records WHERE timestamp >= ?`
    )
    .all(cutoffMs) as Array<{
      id:        string;
      assetCode: string;
      issuer:    string | null;
      stroops:   string;
      timestamp: number;
    }>;

  return rows.map((r) => ({
    id:        r.id,
    assetCode: r.assetCode,
    issuer:    r.issuer ?? undefined,
    stroops:   r.stroops,
    timestamp: r.timestamp,
  }));
}

/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
export function _setDb(db: Database.Database): void {
  _db = db;
}
