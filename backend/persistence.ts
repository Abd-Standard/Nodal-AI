/**
 * backend/persistence.ts
 *
 * SQLite-backed persistence for:
 *   1. AgentResult audit log  (agent_results table)
 *   2. SpendingTracker records (spending_records table) — used for rollback-safe
 *      persistence so that rolled-back reservations are not re-loaded after a
 *      process restart.
 *
 * The DB path is configured via DB_PATH (default: ./agent.db).
 * Pass ":memory:" for in-process testing via _setDb().
 */

import Database from "better-sqlite3";
import type { AgentResult } from "./agent";

export type PersistedResult = AgentResult & { timestamp: string };

/** A row in the spending_records table. */
export interface SpendingRecord {
  /** Unique reservation id — passed through from SpendingTracker.reserve(). */
  readonly id: string;
  /** ISO-8601 timestamp of when the reservation was created. */
  readonly timestamp: string;
  /** Amount as a canonical 7-decimal-place string (e.g. "100.0000000"). */
  readonly amount: string;
  /** Asset key: "XLM" for native, "CODE:ISSUER" for credit assets. */
  readonly assetKey: string;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    // Lazy import of config so that tests can inject via _setDb() before any DB access
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require("./config") as typeof import("./config");
    _db = new Database(config.DB_PATH);
    initSchema(_db);
  }
  return _db;
}

/** Create tables if they don't exist. Called once on first DB open. */
function initSchema(db: Database.Database): void {
  db.exec(`
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
      timestamp TEXT    NOT NULL,
      amount    TEXT    NOT NULL,
      assetKey  TEXT    NOT NULL
    );
  `);
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

  return rows.map((r) => {
    const base = {
      timestamp: r.timestamp,
      taskType:  r.taskType as AgentResult["taskType"],
      success:   r.success === 1,
      data:      r.data !== null ? JSON.parse(r.data) as AgentResult["data"] : undefined,
    };
    // Conditionally add error to satisfy exactOptionalPropertyTypes:
    // the field must be absent (not undefined) when there is no error.
    return r.error !== null
      ? { ...base, error: r.error }
      : base;
  }) as PersistedResult[];
}

// ─── spending_records ─────────────────────────────────────────────────────────

/**
 * Persist a spending reservation row.
 * Called inside SpendingTracker.reserve() — before the async tool executes —
 * so the record survives a process crash between reserve and commit/rollback.
 */
export function saveSpendingRecord(record: SpendingRecord): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO spending_records (id, timestamp, amount, assetKey)
       VALUES (@id, @timestamp, @amount, @assetKey)`
    )
    .run(record);
}

/**
 * Delete a spending record by its reservation id.
 * Called by SpendingTracker.rollback() so that after a restart the rolled-back
 * amount is not reloaded into the in-memory window.
 *
 * This is a no-op (not an error) when the row does not exist, to make the
 * rollback path idempotent.
 */
export function deleteSpendingRecord(id: string): void {
  getDb()
    .prepare(`DELETE FROM spending_records WHERE id = ?`)
    .run(id);
}

/**
 * Load all spending records with a timestamp at or after `cutoffIso`.
 * Called by SpendingTracker on startup to restore the in-memory window from the
 * last process run.
 */
export function getSpendingRecordsSince(cutoffIso: string): SpendingRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT id, timestamp, amount, assetKey
       FROM spending_records
       WHERE timestamp >= ?
       ORDER BY timestamp ASC`
    )
    .all(cutoffIso) as SpendingRecord[];
  return rows;
}

/**
 * Delete all spending records older than `cutoffIso`.
 * Called periodically to keep the table small.
 */
export function pruneSpendingRecords(cutoffIso: string): void {
  getDb()
    .prepare(`DELETE FROM spending_records WHERE timestamp < ?`)
    .run(cutoffIso);
}

/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
export function _setDb(db: Database.Database): void {
  _db = db;
  // Ensure schema exists on the injected DB as well
  initSchema(db);
}
