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
import { migrateSqlite } from './db/migrate';

export type PersistedResult = AgentResult & { timestamp: string };

let _db: Database.Database | null = null;

/**
 * Bring the schema up to date by applying the numbered migrations in
 * `backend/db/migrations/` (#821).
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
  // Event-driven triggers for autonomous PayFi
  db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        filter      TEXT NOT NULL,
        task        TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL,
        last_fired_at TEXT
      )
    `);
  // Trigger event dedupe - prevents double execution on stream replay
  db.exec(`
      CREATE TABLE IF NOT EXISTS trigger_events (
        key       TEXT PRIMARY KEY,
        fired_at  TEXT NOT NULL
  // Value-moving tasks held for a human decision (#736).
  db.exec(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id            TEXT    PRIMARY KEY,
        taskType      TEXT    NOT NULL,
        payload       TEXT    NOT NULL,
        amount        TEXT    NOT NULL,
        correlationId TEXT,
        status        TEXT    NOT NULL,
        createdAt     INTEGER NOT NULL,
        expiresAt     INTEGER NOT NULL,
        decidedAt     INTEGER
      )
    `);
  // One row per approval decision (approved / denied / expired).
  db.exec(`
      CREATE TABLE IF NOT EXISTS approval_audit_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        approvalId TEXT    NOT NULL,
        decision   TEXT    NOT NULL,
        ts         INTEGER NOT NULL
      )
    `);
  // Idempotent migration for databases created before correlationId existed.
  const cols = db.prepare(`PRAGMA table_info(agent_results)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'correlationId')) {
    db.exec(`ALTER TABLE agent_results ADD COLUMN correlationId TEXT`);
  }
  // Migration for errorType column
  if (!cols.some((c) => c.name === 'errorType')) {
    db.exec(`ALTER TABLE agent_results ADD COLUMN errorType TEXT`);
  }
  // Migration for durationMs column
  if (!cols.some((c) => c.name === 'durationMs')) {
    db.exec(`ALTER TABLE agent_results ADD COLUMN durationMs INTEGER`);
  }
  // Idempotency keys table (#payment-idempotency)
  db.exec(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key             TEXT PRIMARY KEY,
        payloadHash     TEXT NOT NULL,
        taskType        TEXT NOT NULL,
        status          TEXT NOT NULL,
        result          TEXT NOT NULL,
        createdAt       INTEGER NOT NULL,
        expiresAt       INTEGER NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_idempotency_expires
        ON idempotency_keys (expiresAt)
    `);
}

/**
 * The shared connection, opened (and migrated) on first use. Exposed so other
 * SQLite-backed stores can reuse it instead of opening a second handle.
 */
export function getDb(): Database.Database {
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
      `INSERT INTO agent_results (timestamp, taskType, success, data, error, errorType, correlationId, durationMs)
       VALUES (@timestamp, @taskType, @success, @data, @error, @errorType, @correlationId, @durationMs)`
    )
    .run({
      timestamp: result.timestamp,
      taskType: result.taskType,
      success: result.success ? 1 : 0,
      data: result.data !== undefined ? JSON.stringify(result.data) : null,
      error: result.error ?? null,
      errorType: result.errorType ?? null,
      correlationId: result.correlationId ?? null,
      durationMs: result.durationMs ?? null,
    });
}

export function getResults(limit = 100, offset = 0): PersistedResult[] {
  const rows = getDb()
    .prepare(
      `SELECT timestamp, taskType, success, data, error, errorType, correlationId, durationMs
       FROM agent_results ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{
      timestamp: string;
      taskType: string;
      success: number;
      data: string | null;
      error: string | null;
      errorType: string | null;
      correlationId: string | null;
      durationMs: number | null;
    }>;

  return rows.map((r) => {
    const result: PersistedResult = {
      timestamp: r.timestamp,
      taskType: r.taskType as AgentResult['taskType'],
      success: r.success === 1,
      data: r.data !== null ? JSON.parse(r.data) : undefined,
    };
    if (r.error !== null) result.error = r.error;
    if (r.errorType !== null) result.errorType = r.errorType;
    if (r.correlationId !== null) result.correlationId = r.correlationId;
    if (r.durationMs !== null) result.durationMs = r.durationMs;
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

/** A spend held against the persisted window by {@link reserveSpendingRecord}. */
export interface SpendingReservation {
  /** Row id; pass to {@link deleteSpendingRecord} to release the hold. */
  id: number;
  /** Cumulative total in the window, including this reservation. */
  total: number;
}

/**
 * Atomically check the window total and record `amount` against it (#822).
 *
 * The sum and the insert run in one IMMEDIATE transaction, which takes
 * SQLite's write lock up front, so two connections can never both see room
 * under `limit` and both insert.
 *
 * @throws if `amount` would push the total of records at or after `sinceMs`
 *   past `limit`; nothing is written in that case.
 */
export function reserveSpendingRecord(
  amount: number,
  limit: number,
  sinceMs: number,
  now: number = Date.now()
): SpendingReservation {
  const db = getDb();
  const reserve = db.transaction((): SpendingReservation => {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM spending_records
         WHERE timestamp >= ?`
      )
      .get(sinceMs) as { total: number };
    const total = row.total + amount;
    if (total > limit) {
      throw new Error(`Cumulative spending ${total} exceeds limit ${limit}`);
    }
    const info = db
      .prepare(`INSERT INTO spending_records (amount, timestamp) VALUES (?, ?)`)
      .run(amount, now);
    return { id: Number(info.lastInsertRowid), total };
  });
  return reserve.immediate();
}

/** Remove one spending record, e.g. to release a reservation whose submission failed. */
export function deleteSpendingRecord(id: number): void {
  getDb().prepare(`DELETE FROM spending_records WHERE id = ?`).run(id);
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

// ─── Pending approvals (#736) ─────────────────────────────────────────────────

export type ApprovalStatus = 'pending_approval' | 'approved' | 'denied' | 'expired';

/** A value-moving task held until an operator approves or denies it. */
export interface PendingApproval {
  id: string;
  taskType: string;
  payload: unknown;
  amount: string;
  correlationId: string | null;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
}

export interface ApprovalAuditRow {
  approvalId: string;
  decision: Exclude<ApprovalStatus, 'pending_approval'>;
  ts: number;
}

type ApprovalRow = Omit<PendingApproval, 'payload'> & { payload: string };

function toPendingApproval(row: ApprovalRow): PendingApproval {
  return { ...row, payload: JSON.parse(row.payload) };
}

/** Persist a newly held task in the `pending_approval` state. */
export function savePendingApproval(
  approval: Omit<PendingApproval, 'status' | 'decidedAt'>
): void {
  getDb()
    .prepare(
      `INSERT INTO pending_approvals
         (id, taskType, payload, amount, correlationId, status, createdAt, expiresAt, decidedAt)
       VALUES
         (@id, @taskType, @payload, @amount, @correlationId, 'pending_approval', @createdAt,
          @expiresAt, NULL)`
    )
    .run({ ...approval, payload: JSON.stringify(approval.payload ?? null) });
}

export function getPendingApproval(id: string): PendingApproval | undefined {
  const row = getDb().prepare(`SELECT * FROM pending_approvals WHERE id = ?`).get(id) as
    | ApprovalRow
    | undefined;
  return row ? toPendingApproval(row) : undefined;
}

/** Approvals still waiting for a decision, oldest first. */
export function listPendingApprovals(): PendingApproval[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM pending_approvals WHERE status = 'pending_approval' ORDER BY createdAt ASC`
    )
    .all() as ApprovalRow[];
  return rows.map(toPendingApproval);
}

/**
 * Move a pending, unexpired approval to `approved` or `denied` and record the
 * decision in the audit log. The status check is part of the UPDATE, so of two
 * concurrent decisions only one can win.
 *
 * @returns true when this call made the decision, false when the approval was
 *   unknown, already decided or expired.
 */
export function decideApproval(
  id: string,
  decision: 'approved' | 'denied',
  now: number = Date.now()
): boolean {
  const db = getDb();
  const decide = db.transaction((): boolean => {
    const info = db
      .prepare(
        `UPDATE pending_approvals SET status = ?, decidedAt = ?
         WHERE id = ? AND status = 'pending_approval' AND expiresAt > ?`
      )
      .run(decision, now, id, now);
    if (info.changes !== 1) return false;
    db.prepare(`INSERT INTO approval_audit_log (approvalId, decision, ts) VALUES (?, ?, ?)`).run(
      id,
      decision,
      now
    );
    return true;
  });
  return decide();
}

/**
 * Mark every pending approval past its deadline as `expired`, recording each in
 * the audit log.
 *
 * @returns the ids that expired in this call.
 */
export function expirePendingApprovals(now: number = Date.now()): string[] {
  const db = getDb();
  const expire = db.transaction((): string[] => {
    const rows = db
      .prepare(
        `SELECT id FROM pending_approvals WHERE status = 'pending_approval' AND expiresAt <= ?`
      )
      .all(now) as Array<{ id: string }>;
    const update = db.prepare(
      `UPDATE pending_approvals SET status = 'expired', decidedAt = ? WHERE id = ?`
    );
    const audit = db.prepare(
      `INSERT INTO approval_audit_log (approvalId, decision, ts) VALUES (?, 'expired', ?)`
    );
    for (const { id } of rows) {
      update.run(now, id);
      audit.run(id, now);
    }
    return rows.map((r) => r.id);
  });
  return expire();
}

/** Every approval decision, oldest first. */
export function getApprovalAuditLog(): ApprovalAuditRow[] {
  return getDb()
    .prepare(`SELECT approvalId, decision, ts FROM approval_audit_log ORDER BY id ASC`)
    .all() as ApprovalAuditRow[];
}

/**
 * Compute SHA-256 hash of the payload for idempotency comparison.
 */
function computePayloadHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

/**
 * Result status for idempotency tracking.
 */
type IdempotencyStatus = 'pending' | 'success' | 'failure';

/**
 * Stored idempotency record.
 */
interface IdempotencyRecord {
  key: string;
  payloadHash: string;
  taskType: string;
  status: IdempotencyStatus;
  result: AgentResult;
  createdAt: number;
  expiresAt: number;
}

/**
 * Check if an idempotency key exists and is valid (not expired).
 * Returns the stored result if the key exists with the same payload hash.
 * Returns { conflict: true } if the key exists but payload differs.
 * Returns null if the key doesn't exist or has expired.
 */
export function getIdempotencyResult(
  key: string,
  payload: unknown
): AgentResult | { conflict: true } | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT payloadHash, taskType, status, result, expiresAt
       FROM idempotency_keys WHERE key = ?`
    )
    .get(key) as
    | {
        payloadHash: string;
        taskType: string;
        status: IdempotencyStatus;
        result: string;
        expiresAt: number;
      }
    | undefined;

  if (!row) return null;

  // Check if expired
  if (Date.now() > row.expiresAt) {
    // Clean up expired key
    db.prepare(`DELETE FROM idempotency_keys WHERE key = ?`).run(key);
    return null;
  }

  // Check payload hash match
  const payloadHash = computePayloadHash(payload);
  if (row.payloadHash !== payloadHash) {
    return { conflict: true };
  }

  // Return stored result
  return JSON.parse(row.result) as AgentResult;
}

/**
 * Store an idempotency key with the result.
 * Keys expire after 24 hours.
 */
export function saveIdempotencyResult(
  key: string,
  taskType: string,
  payload: unknown,
  result: AgentResult
): void {
  const db = getDb();
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

  db.prepare(
    `INSERT OR REPLACE INTO idempotency_keys
       (key, payloadHash, taskType, status, result, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    key,
    computePayloadHash(payload),
    taskType,
    result.success ? 'success' : 'failure',
    JSON.stringify(result),
    now,
    expiresAt
  );
}

/**
 * Prune expired idempotency keys. Called periodically to clean up old entries.
 */
export function pruneIdempotencyKeys(): number {
  const db = getDb();
  const now = Date.now();
  const result = db.prepare(`DELETE FROM idempotency_keys WHERE expiresAt < ?`).run(now);
  return result.changes;
}

/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
export function _setDb(db: Database.Database | null): void {
  _db = db;
  if (_db) {
    applySchema(_db);
  }
}
