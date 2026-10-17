/**
 * backend/persistence.ts
 *
 * SQLite-backed audit log for every AgentResult produced by PayFiAgent.run().
 * The DB path is configured via DB_PATH (default: ./agent.db).
 * Pass ":memory:" for in-process testing via _setDb().
 */

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import type { AgentResult } from './agent';

export type PersistedResult = AgentResult & { timestamp: string };

let _db: Database.Database | null = null;

/**
 * Create every table this module owns, plus the idempotent migrations.
 *
 * Applied both to the lazily opened connection and to any DB injected through
 * `_setDb()`, so a test database has the same shape as a real one and the two
 * cannot drift apart.
 */
function applySchema(db: Database.Database): void {
  db.exec(`
      CREATE TABLE IF NOT EXISTS agent_results (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT    NOT NULL,
        taskType      TEXT    NOT NULL,
        success       INTEGER NOT NULL,
        data          TEXT,
        error         TEXT,
        correlationId TEXT
      )
    `);
  // Rolling spending window (#372). Kept here so the tracker survives a
  // restart instead of silently resetting its cumulative total to zero.
  db.exec(`
      CREATE TABLE IF NOT EXISTS spending_records (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        amount    REAL    NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_spending_records_timestamp
        ON spending_records (timestamp)
    `);
  // Operator-controlled agent state (e.g. the kill switch), kept across restarts.
  db.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  // Idempotent migration for databases created before correlationId existed.
  const cols = db.prepare(`PRAGMA table_info(agent_results)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'correlationId')) {
    db.exec(`ALTER TABLE agent_results ADD COLUMN correlationId TEXT`);
  }
}

function getDb(): Database.Database {
  if (!_db) {
    // Lazy import of config so that tests can inject via _setDb() before any DB access
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('./config') as typeof import('./config');
    _db = new Database(config.DB_PATH);
    applySchema(_db);
  }
  return _db;
}

/**
 * Close the live connection and drop the cached handle (#644).
 *
 * `getDb()` owns the only `better-sqlite3` handle, so releasing it belongs here
 * rather than in DatabaseManager. After this call the next access re-opens a
 * fresh connection via `getDb()`. Safe to call when no connection is open.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Execute a trivial query against the live connection (#234).
 *
 * `getDb()` owns the only `better-sqlite3` handle, so the probe belongs here
 * rather than in DatabaseManager — duplicating connection ownership to satisfy
 * a health check would mean the check exercised a handle the app does not use.
 *
 * Throws if the file is missing, corrupt, or the connection is in a bad state,
 * which is exactly what an in-memory boolean cannot detect.
 */
export function probeDb(): void {
  getDb().prepare('SELECT 1').get();
}

export function saveResult(result: PersistedResult): void {
  getDb()
    .prepare(
      `INSERT INTO agent_results (timestamp, taskType, success, data, error, correlationId)
       VALUES (@timestamp, @taskType, @success, @data, @error, @correlationId)`
    )
    .run({
      timestamp: result.timestamp,
      taskType: result.taskType,
      success: result.success ? 1 : 0,
      data: result.data !== undefined ? JSON.stringify(result.data) : null,
      error: result.error ?? null,
      correlationId: result.correlationId ?? null,
    });
}

export function getResults(limit = 100, offset = 0): PersistedResult[] {
  const rows = getDb()
    .prepare(
      `SELECT timestamp, taskType, success, data, error, correlationId
       FROM agent_results ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{
    timestamp: string;
    taskType: string;
    success: number;
    data: string | null;
    error: string | null;
    correlationId: string | null;
  }>;

  return rows.map((r) => {
    const result: PersistedResult = {
      timestamp: r.timestamp,
      taskType: r.taskType as AgentResult['taskType'],
      success: r.success === 1,
      data: r.data !== null ? JSON.parse(r.data) : undefined,
    };
    if (r.error !== null) result.error = r.error;
    if (r.correlationId !== null) result.correlationId = r.correlationId;
    return result;
  });
}

// ─── Audit log (#744) ─────────────────────────────────────────────────────────

/** `prevHash` of the first row in the chain. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

/** Who/what/why of one signed transaction. */
export interface AuditEntry {
  ts: string;
  correlationId: string | null;
  taskType: string;
  txHash: string;
  envelopeHash: string | null;
  destination: string | null;
  asset: string | null;
  amount: string | null;
}

export interface AuditRow extends AuditEntry {
  id: number;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  /** Number of rows checked. */
  checked: number;
  /** id of the first row that fails verification. */
  brokenAt?: number;
  reason?: string;
}

/**
 * `sha256(prevHash || row)`. The row is serialised as a JSON array in a fixed
 * column order so the encoding is unambiguous and independent of key order.
 */
export function computeAuditHash(prevHash: string, entry: AuditEntry): string {
  const row = JSON.stringify([
    entry.ts,
    entry.correlationId,
    entry.taskType,
    entry.txHash,
    entry.envelopeHash,
    entry.destination,
    entry.asset,
    entry.amount,
  ]);
  return createHash('sha256').update(prevHash).update(row).digest('hex');
}

/**
 * Append one signed transaction to the audit log, chained to the previous row.
 * Reading the last hash and inserting run in one transaction so two appends
 * can never chain off the same predecessor.
 */
export function appendAuditEntry(entry: AuditEntry): AuditRow {
  const db = getDb();
  const append = db.transaction((e: AuditEntry): AuditRow => {
    const last = db.prepare(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`).get() as
      | { hash: string }
      | undefined;
    const prevHash = last?.hash ?? AUDIT_GENESIS_HASH;
    const hash = computeAuditHash(prevHash, e);
    const info = db
      .prepare(
        `INSERT INTO audit_log
           (ts, correlationId, taskType, txHash, envelopeHash, destination, asset, amount,
            prevHash, hash)
         VALUES
           (@ts, @correlationId, @taskType, @txHash, @envelopeHash, @destination, @asset,
            @amount, @prevHash, @hash)`
      )
      .run({ ...e, prevHash, hash });
    return { ...e, id: Number(info.lastInsertRowid), prevHash, hash };
  });
  return append(entry);
}

/** Every audit row, oldest first. */
export function getAuditLog(db: Database.Database = getDb()): AuditRow[] {
  return db
    .prepare(
      `SELECT id, ts, correlationId, taskType, txHash, envelopeHash, destination, asset, amount,
              prevHash, hash
       FROM audit_log ORDER BY id ASC`
    )
    .all() as AuditRow[];
}

/**
 * Walk the chain from the genesis hash and recompute every row's hash.
 * Detects a modified row (its hash no longer matches its contents) and a
 * removed or reordered row (the next row's prevHash no longer links up).
 */
export function verifyAuditChain(db: Database.Database = getDb()): AuditVerification {
  const rows = getAuditLog(db);
  let expectedPrev = AUDIT_GENESIS_HASH;
  for (const row of rows) {
    if (row.prevHash !== expectedPrev) {
      return {
        ok: false,
        checked: rows.length,
        brokenAt: row.id,
        reason: 'prevHash does not match the previous row — a row was removed or reordered',
      };
    }
    if (computeAuditHash(row.prevHash, row) !== row.hash) {
      return {
        ok: false,
        checked: rows.length,
        brokenAt: row.id,
        reason: 'hash does not match row contents — the row was modified',
      };
    }
    expectedPrev = row.hash;
  }
  return { ok: true, checked: rows.length };
}

/** One recorded payment inside the rolling spending window (#372). */
export interface SpendingRecord {
  amount: number;
  timestamp: number;
}

/** Append a payment to the persisted spending window. */
export function saveSpendingRecord(record: SpendingRecord): void {
  getDb()
    .prepare(`INSERT INTO spending_records (amount, timestamp) VALUES (@amount, @timestamp)`)
    .run({ amount: record.amount, timestamp: record.timestamp });
}

/** Records at or after `sinceMs`, oldest first. */
export function loadSpendingRecords(sinceMs: number): SpendingRecord[] {
  return getDb()
    .prepare(
      `SELECT amount, timestamp FROM spending_records
       WHERE timestamp >= ? ORDER BY timestamp ASC`
    )
    .all(sinceMs) as SpendingRecord[];
}

/** Drop records that have fallen out of the window. */
export function pruneSpendingRecords(cutoffMs: number): void {
  getDb().prepare(`DELETE FROM spending_records WHERE timestamp < ?`).run(cutoffMs);
}

/** Drop the whole persisted window. */
export function clearSpendingRecords(): void {
  getDb().prepare(`DELETE FROM spending_records`).run();
}

/** Persist a single agent-state value, replacing any previous one. */
export function saveAgentState(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_state (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run({ key, value });
}

/** Read a persisted agent-state value, or undefined when it was never set. */
export function loadAgentState(key: string): string | undefined {
  const row = getDb().prepare(`SELECT value FROM agent_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
export function _setDb(db: Database.Database | null): void {
  _db = db;
  if (_db) {
    applySchema(_db);
  }
}
