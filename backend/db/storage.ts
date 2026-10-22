/**
 * backend/db/storage.ts
 *
 * Storage — the backend-agnostic contract for everything the agent persists
 * (#822): agent results, the audit log, agent state, the spending window and
 * x402 nonces.
 *
 * Two implementations:
 *   • SqliteStorage   — the default; a local file, single instance only.
 *   • PostgresStorage — a shared database for multi-instance deployments
 *     (backend/db/postgres.ts). Select it with STORAGE_BACKEND=postgres and
 *     DATABASE_URL.
 *
 * Every method is async so both backends share one call shape, even though
 * better-sqlite3 itself is synchronous.
 */

import type { INonceStore } from '../nonce_store';
import { SqliteNonceStore } from '../nonce_store';
import * as persistence from '../persistence';
import type {
  AuditEntry,
  AuditRow,
  PersistedResult,
  SpendingRecord,
  SpendingReservation,
} from '../persistence';
import { migrateSqlite } from './migrate';

export type StorageBackend = 'sqlite' | 'postgres';

export interface Storage {
  readonly backend: StorageBackend;

  /** Apply pending schema migrations; returns how many were applied. */
  migrate(): Promise<number>;
  /** Run a trivial query; throws when the store is unreachable. */
  probe(): Promise<void>;
  /** Release connections. */
  close(): Promise<void>;

  saveResult(result: PersistedResult): Promise<void>;
  getResults(limit?: number, offset?: number): Promise<PersistedResult[]>;

  appendAuditEntry(entry: AuditEntry): Promise<AuditRow>;
  getAuditLog(): Promise<AuditRow[]>;

  saveAgentState(key: string, value: string): Promise<void>;
  loadAgentState(key: string): Promise<string | undefined>;

  saveSpendingRecord(record: SpendingRecord): Promise<void>;
  loadSpendingRecords(sinceMs: number): Promise<SpendingRecord[]>;
  pruneSpendingRecords(cutoffMs: number): Promise<void>;
  clearSpendingRecords(): Promise<void>;
  /**
   * Atomically check the window total (records at or after `sinceMs`) and
   * record `amount` against it. Concurrent callers — including other
   * instances sharing the same database — are serialised, so they can never
   * jointly exceed `limit`.
   *
   * @throws when `amount` would push the total past `limit`.
   */
  reserveSpending(
    amount: number,
    limit: number,
    sinceMs: number,
    now?: number
  ): Promise<SpendingReservation>;
  /** Release a reservation, e.g. after a failed submission. */
  releaseSpending(id: number): Promise<void>;

  /** Nonce store sharing this storage's database. */
  nonceStore(): INonceStore;
}

// ─── SQLite ───────────────────────────────────────────────────────────────────

/**
 * SQLite storage over the connection owned by backend/persistence.ts, so it
 * reads and writes exactly what the rest of the process does.
 */
export class SqliteStorage implements Storage {
  readonly backend = 'sqlite' as const;

  async migrate(): Promise<number> {
    return migrateSqlite(persistence.getDb()).length;
  }

  async probe(): Promise<void> {
    persistence.probeDb();
  }

  async close(): Promise<void> {
    persistence.closeDb();
  }

  async saveResult(result: PersistedResult): Promise<void> {
    persistence.saveResult(result);
  }

  async getResults(limit?: number, offset?: number): Promise<PersistedResult[]> {
    return persistence.getResults(limit, offset);
  }

  async appendAuditEntry(entry: AuditEntry): Promise<AuditRow> {
    return persistence.appendAuditEntry(entry);
  }

  async getAuditLog(): Promise<AuditRow[]> {
    return persistence.getAuditLog();
  }

  async saveAgentState(key: string, value: string): Promise<void> {
    persistence.saveAgentState(key, value);
  }

  async loadAgentState(key: string): Promise<string | undefined> {
    return persistence.loadAgentState(key);
  }

  async saveSpendingRecord(record: SpendingRecord): Promise<void> {
    persistence.saveSpendingRecord(record);
  }

  async loadSpendingRecords(sinceMs: number): Promise<SpendingRecord[]> {
    return persistence.loadSpendingRecords(sinceMs);
  }

  async pruneSpendingRecords(cutoffMs: number): Promise<void> {
    persistence.pruneSpendingRecords(cutoffMs);
  }

  async clearSpendingRecords(): Promise<void> {
    persistence.clearSpendingRecords();
  }

  async reserveSpending(
    amount: number,
    limit: number,
    sinceMs: number,
    now?: number
  ): Promise<SpendingReservation> {
    return persistence.reserveSpendingRecord(amount, limit, sinceMs, now);
  }

  async releaseSpending(id: number): Promise<void> {
    persistence.deleteSpendingRecord(id);
  }

  nonceStore(): INonceStore {
    return new SqliteNonceStore(persistence.getDb());
  }
}

// ─── Process-wide instance ────────────────────────────────────────────────────

let _storage: Storage | null = null;

/**
 * The storage selected by STORAGE_BACKEND, created on first use. The Postgres
 * module (and the `pg` driver) is only loaded when it is selected.
 */
export function getStorage(): Storage {
  if (!_storage) {
    // Lazy import of config, matching persistence.ts, so tests can inject first.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('../config') as typeof import('../config');
    if (config.STORAGE_BACKEND === 'postgres') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PostgresStorage } = require('./postgres') as typeof import('./postgres');
      _storage = PostgresStorage.fromUrl(config.DATABASE_URL as string);
    } else {
      _storage = new SqliteStorage();
    }
  }
  return _storage;
}

/** Replace the process-wide storage — used in tests. */
export function _setStorage(storage: Storage | null): void {
  _storage = storage;
}

