/**
 * backend/db/postgres.ts
 *
 * Postgres implementation of {@link Storage} for multi-instance deployments
 * (#822). Every instance pointed at the same DATABASE_URL shares one spending
 * window, one nonce set and one audit chain.
 *
 * Concurrency:
 *   • Spending reservations lock the single `spending_lock` row with
 *     SELECT … FOR UPDATE before summing the window, so concurrent
 *     reservations — from any instance — are serialised.
 *   • Audit appends take a transaction-scoped advisory lock so two rows can
 *     never chain off the same predecessor.
 *   • Migrations run under a session advisory lock (see migrate.ts).
 */

import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { INonceStore } from '../nonce_store';
import { configuredTtlMs } from '../nonce_store';
import { AUDIT_GENESIS_HASH, computeAuditHash } from '../persistence';
import type {
  AuditEntry,
  AuditRow,
  PersistedResult,
  SpendingRecord,
  SpendingReservation,
} from '../persistence';
import type { AgentResult } from '../agent';
import { migratePostgres } from './migrate';
import type { Storage } from './storage';

/** Advisory-lock key serialising audit-log appends. Arbitrary but fixed. */
const AUDIT_LOCK_KEY = 7_440_744;

/** The subset of `pg.Pool` this module uses, so tests can supply their own. */
export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

/** Run `fn` inside a transaction on a dedicated pooled client. */
async function withTransaction<T>(
  pool: PgPool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const AUDIT_COLUMNS = `id, ts, "correlationId", "taskType", "txHash", "envelopeHash",
  destination, asset, amount, "prevHash", hash`;

export class PostgresStorage implements Storage {
  readonly backend = 'postgres' as const;

  constructor(private readonly pool: PgPool) {}

  /** Create a storage backed by a new connection pool for `url`. */
  static fromUrl(url: string): PostgresStorage {
    if (!url) {
      throw new Error('DATABASE_URL is required when STORAGE_BACKEND=postgres');
    }
    return new PostgresStorage(new Pool({ connectionString: url }));
  }

  async migrate(): Promise<number> {
    const client = await this.pool.connect();
    try {
      return (await migratePostgres(client)).length;
    } finally {
      client.release();
    }
  }

  async probe(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ─── Agent results ──────────────────────────────────────────────────────────

  async saveResult(result: PersistedResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_results ("timestamp", "taskType", success, data, error, "correlationId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        result.timestamp,
        result.taskType,
        result.success,
        result.data !== undefined ? JSON.stringify(result.data) : null,
        result.error ?? null,
        result.correlationId ?? null,
      ]
    );
  }

  async getResults(limit = 100, offset = 0): Promise<PersistedResult[]> {
    const { rows } = await this.pool.query(
      `SELECT "timestamp", "taskType", success, data, error, "correlationId"
       FROM agent_results ORDER BY id DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows.map(
      (r: {
        timestamp: string;
        taskType: string;
        success: boolean;
        data: string | null;
        error: string | null;
        correlationId: string | null;
      }) => {
        const result: PersistedResult = {
          timestamp: r.timestamp,
          taskType: r.taskType as AgentResult['taskType'],
          success: r.success,
          data: r.data !== null ? JSON.parse(r.data) : undefined,
        };
        if (r.error !== null) result.error = r.error;
        if (r.correlationId !== null) result.correlationId = r.correlationId;
        return result;
      }
    );
  }

  // ─── Audit log ──────────────────────────────────────────────────────────────

  async appendAuditEntry(entry: AuditEntry): Promise<AuditRow> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);
      const last = await client.query(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`);
      const prevHash: string = last.rows[0]?.hash ?? AUDIT_GENESIS_HASH;
      const hash = computeAuditHash(prevHash, entry);
      const inserted = await client.query(
        `INSERT INTO audit_log
           (ts, "correlationId", "taskType", "txHash", "envelopeHash", destination, asset,
            amount, "prevHash", hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          entry.ts,
          entry.correlationId,
          entry.taskType,
          entry.txHash,
          entry.envelopeHash,
          entry.destination,
          entry.asset,
          entry.amount,
          prevHash,
          hash,
        ]
      );
      return { ...entry, id: Number(inserted.rows[0].id), prevHash, hash };
    });
  }

  async getAuditLog(): Promise<AuditRow[]> {
    const { rows } = await this.pool.query(`SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY id ASC`);
    return rows.map((r: AuditRow) => ({ ...r, id: Number(r.id) }));
  }

  // ─── Agent state ────────────────────────────────────────────────────────────

  async saveAgentState(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }

  async loadAgentState(key: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(`SELECT value FROM agent_state WHERE key = $1`, [key]);
    return rows[0]?.value;
  }

  // ─── Spending window ────────────────────────────────────────────────────────

  async saveSpendingRecord(record: SpendingRecord): Promise<void> {
    await this.pool.query(`INSERT INTO spending_records (amount, "timestamp") VALUES ($1, $2)`, [
      record.amount,
      record.timestamp,
    ]);
  }

  async loadSpendingRecords(sinceMs: number): Promise<SpendingRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT amount, "timestamp" FROM spending_records
       WHERE "timestamp" >= $1 ORDER BY "timestamp" ASC`,
      [sinceMs]
    );
    // BIGINT comes back as a string from node-postgres.
    return rows.map((r: { amount: number; timestamp: string }) => ({
      amount: Number(r.amount),
      timestamp: Number(r.timestamp),
    }));
  }

  async pruneSpendingRecords(cutoffMs: number): Promise<void> {
    await this.pool.query(`DELETE FROM spending_records WHERE "timestamp" < $1`, [cutoffMs]);
  }

  async clearSpendingRecords(): Promise<void> {
    await this.pool.query(`DELETE FROM spending_records`);
  }

  async reserveSpending(
    amount: number,
    limit: number,
    sinceMs: number,
    now: number = Date.now()
  ): Promise<SpendingReservation> {
    return withTransaction(this.pool, async (client) => {
      // Row lock: every reservation, on every instance, queues here until the
      // previous one commits, so the sum below always sees its insert.
      await client.query(`SELECT id FROM spending_lock WHERE id = 1 FOR UPDATE`);
      const sum = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM spending_records
         WHERE "timestamp" >= $1`,
        [sinceMs]
      );
      const total = Number(sum.rows[0].total) + amount;
      if (total > limit) {
        throw new Error(`Cumulative spending ${total} exceeds limit ${limit}`);
      }
      const inserted = await client.query(
        `INSERT INTO spending_records (amount, "timestamp") VALUES ($1, $2) RETURNING id`,
        [amount, now]
      );
      return { id: Number(inserted.rows[0].id), total };
    });
  }

  async releaseSpending(id: number): Promise<void> {
    await this.pool.query(`DELETE FROM spending_records WHERE id = $1`, [id]);
  }

  // ─── Nonces ─────────────────────────────────────────────────────────────────

  nonceStore(): INonceStore {
    return new PostgresNonceStore(this.pool);
  }
}

/**
 * Postgres-backed x402 nonce store, shared by every instance using the same
 * database. Same semantics as SqliteNonceStore: expired nonces are evicted on
 * every access and add() is idempotent.
 */
export class PostgresNonceStore implements INonceStore {
  constructor(
    private readonly pool: Pick<PgPool, 'query'>,
    private readonly ttlMs: () => number = configuredTtlMs
  ) {}

  async has(nonce: string): Promise<boolean> {
    await this.prune();
    const { rows } = await this.pool.query(`SELECT 1 FROM x402_used_nonces WHERE nonce = $1`, [
      nonce,
    ]);
    return rows.length > 0;
  }

  async add(nonce: string): Promise<void> {
    await this.prune();
    await this.pool.query(
      `INSERT INTO x402_used_nonces (nonce, used_at_ms) VALUES ($1, $2)
       ON CONFLICT (nonce) DO NOTHING`,
      [nonce, Date.now()]
    );
  }

  async prune(ttlMs: number = this.ttlMs()): Promise<void> {
    await this.pool.query(`DELETE FROM x402_used_nonces WHERE used_at_ms < $1`, [
      Date.now() - ttlMs,
    ]);
  }
}
