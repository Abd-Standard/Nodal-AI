/**
 * backend/persistence.ts
 *
 * SQLite-backed audit log persistence layer.
 *
 * Features:
 *   - Schema versioning via a `_meta` table — incremental ALTER TABLE migrations
 *     run automatically on startup, avoiding the "IF NOT EXISTS stuck schema" problem.
 *   - Paginated query with limit + offset for cursor-free iteration.
 *   - WAL journal mode for better concurrent read performance.
 */

import Database from "better-sqlite3";
import { createLogger } from "./utils/logger";

const log = createLogger("persistence");

// ─── Schema versioning ────────────────────────────────────────────────────────

/**
 * Bump this when the results table shape changes (e.g., adding a column).
 * Incremental migrations run for each version gap on startup.
 */
const CURRENT_SCHEMA_VERSION = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PersistedResult {
  id: number;
  taskType: string;
  success: boolean;
  data?: string | null;
  error?: string | null;
  correlationId?: string | null;
  createdAt: string;
}

// ─── Database singleton ───────────────────────────────────────────────────────

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database("agent_audit.db");
    db.pragma("journal_mode = WAL");
    runMigrations(db);
    log.info({ msg: "SQLite database opened", schemaVersion: CURRENT_SCHEMA_VERSION });
  }
  return db;
}

// ─── Migrations ───────────────────────────────────────────────────────────────

function runMigrations(database: Database.Database): void {
  // Create the _meta table if it does not exist
  database.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Read current schema version from _meta (defaults to 0 for fresh installs)
  const row = database
    .prepare("SELECT value FROM _meta WHERE key = ?")
    .get("schema_version") as { value: string } | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  // ── v0 → v1: create results table ────────────────────────────────────────
  if (currentVersion < 1) {
    log.info({ msg: "Running migration v0 → v1: creating results table" });
    database.exec(`
      CREATE TABLE IF NOT EXISTS results (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        taskType      TEXT    NOT NULL,
        success       INTEGER NOT NULL,
        data          TEXT,
        error         TEXT,
        correlationId TEXT,
        createdAt     TEXT    NOT NULL DEFAULT (datetime('now'))
      )
    `);
    database
      .prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)")
      .run("schema_version", "1");
  }

  // Future migrations go here. Example:
  // if (currentVersion < 2) {
  //   log.info({ msg: "Running migration v1 → v2: adding correlationId column" });
  //   database.exec("ALTER TABLE results ADD COLUMN correlationId TEXT");
  //   database
  //     .prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)")
  //     .run("schema_version", "2");
  // }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist an agent execution result to the audit log.
 */
export function saveResult(result: Omit<PersistedResult, "id" | "createdAt">): void {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO results (taskType, success, data, error, correlationId)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    result.taskType,
    result.success ? 1 : 0,
    result.data ?? null,
    result.error ?? null,
    result.correlationId ?? null
  );
  log.info({ msg: "Result persisted", taskType: result.taskType });
}

/**
 * Retrieve paginated audit log entries, newest first.
 *
 * @param limit  Max rows to return (default 100).
 * @param offset Number of rows to skip (default 0) — enables cursor-based pagination.
 */
export function getResults(limit = 100, offset = 0): PersistedResult[] {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT id, taskType, success, data, error, correlationId, createdAt
       FROM results
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as (Omit<PersistedResult, "success"> & { success: number })[];

  return rows.map((row) => ({
    ...row,
    success: Boolean(row.success),
  }));
}

/**
 * Close the database connection gracefully.
 * Safe to call during shutdown even if the database was never opened.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    log.info({ msg: "SQLite database closed" });
  }
}
