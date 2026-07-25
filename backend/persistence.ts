/**
 * backend/persistence.ts
 *
 * SQLite-backed audit log for every AgentResult produced by PayFiAgent.run().
 * The DB path is configured via DB_PATH (default: ./agent.db).
 * Pass ":memory:" for in-process testing via _setDb().
 */

import Database from "better-sqlite3";
import type { AgentResult } from "./agent";

export type PersistedResult = AgentResult & { timestamp: string };

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
      )
    `);
  }
  return _db;
}

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

/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
export function _setDb(db: Database.Database): void {
  _db = db;
}
