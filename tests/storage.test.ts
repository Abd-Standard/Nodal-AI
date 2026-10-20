/**
 * tests/storage.test.ts
 *
 * One behavioural suite for the Storage interface (#822), run against every
 * backend: SQLite always (in-memory), Postgres when TEST_DATABASE_URL points
 * at a database the suite may freely truncate, e.g.
 *
 *   docker compose --profile postgres run --rm test-runner-postgres
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

vi.mock('../backend/config', () => ({
  config: {
    X402_NONCE_TTL_MS: 60_000,
  },
}));

import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { _setDb, computeAuditHash, AUDIT_GENESIS_HASH } from '../backend/persistence';
import type { AuditEntry } from '../backend/persistence';
import { SqliteStorage } from '../backend/db/storage';
import type { Storage } from '../backend/db/storage';
import { PostgresStorage } from '../backend/db/postgres';

interface Backend {
  name: string;
  /** Create (or reuse) the storage and migrate it. */
  setup(): Promise<Storage>;
  /** Empty every table so each test starts from a clean store. */
  reset(storage: Storage): Promise<void>;
  teardown(storage: Storage): Promise<void>;
}

const sqliteBackend: Backend = {
  name: 'sqlite',
  async setup() {
    _setDb(new Database(':memory:'));
    const storage = new SqliteStorage();
    await storage.migrate();
    return storage;
  },
  async reset() {
    // A brand-new in-memory database per test.
    _setDb(new Database(':memory:'));
  },
  async teardown(storage) {
    await storage.close();
  },
};

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let pgPool: Pool | null = null;

const postgresBackend: Backend = {
  name: 'postgres',
  async setup() {
    pgPool = new Pool({ connectionString: TEST_DATABASE_URL });
    const storage = new PostgresStorage(pgPool);
    await storage.migrate();
    return storage;
  },
  async reset() {
    // TRUNCATE does not fire the audit_log row triggers.
    await pgPool!.query(
      `TRUNCATE agent_results, spending_records, agent_state, x402_used_nonces, audit_log
       RESTART IDENTITY`
    );
  },
  async teardown(storage) {
    await storage.close();
  },
};

const backends = [sqliteBackend, ...(TEST_DATABASE_URL ? [postgresBackend] : [])];

function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-10-16T12:00:00.000Z',
    correlationId: 'corr-1',
    taskType: 'stellar_payment',
    txHash: 'a'.repeat(64),
    envelopeHash: null,
    destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    asset: 'XLM',
    amount: '10',
    ...overrides,
  };
}

describe.each(backends)('Storage ($name)', (backend) => {
  let storage: Storage;

  beforeAll(async () => {
    storage = await backend.setup();
  });

  beforeEach(async () => {
    await backend.reset(storage);
  });

  afterAll(async () => {
    await backend.teardown(storage);
  });

  it('answers the health probe', async () => {
    await expect(storage.probe()).resolves.toBeUndefined();
  });

  it('applies nothing when migrated again', async () => {
    expect(await storage.migrate()).toBe(0);
  });

  describe('agent results', () => {
    it('round-trips results, newest first', async () => {
      await storage.saveResult({
        timestamp: '2026-01-01T00:00:00.000Z',
        taskType: 'stellar_payment',
        success: true,
        data: { txHash: 'abc' },
        correlationId: 'corr-1',
      });
      await storage.saveResult({
        timestamp: '2026-01-01T00:00:01.000Z',
        taskType: 'stellar_payment',
        success: false,
        error: 'boom',
      });

      const results = await storage.getResults();

      expect(results).toEqual([
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          taskType: 'stellar_payment',
          success: false,
          data: undefined,
          error: 'boom',
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          taskType: 'stellar_payment',
          success: true,
          data: { txHash: 'abc' },
          correlationId: 'corr-1',
        },
      ]);
    });

    it('honours limit and offset', async () => {
      for (let i = 0; i < 3; i++) {
        await storage.saveResult({
          timestamp: `2026-01-01T00:00:0${i}.000Z`,
          taskType: 'stellar_payment',
          success: true,
        });
      }

      const page = await storage.getResults(1, 1);

      expect(page.map((r) => r.timestamp)).toEqual(['2026-01-01T00:00:01.000Z']);
    });
  });

  describe('audit log', () => {
    it('chains each row to the previous one', async () => {
      const first = await storage.appendAuditEntry(makeAuditEntry());
      const second = await storage.appendAuditEntry(makeAuditEntry({ amount: '20' }));

      expect(first.prevHash).toBe(AUDIT_GENESIS_HASH);
      expect(first.hash).toBe(computeAuditHash(AUDIT_GENESIS_HASH, makeAuditEntry()));
      expect(second.prevHash).toBe(first.hash);

      const log = await storage.getAuditLog();
      expect(log.map((r) => r.id)).toEqual([first.id, second.id]);
      expect(log[1]).toEqual(second);
    });

    it('keeps one unbroken chain under concurrent appends', async () => {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          storage.appendAuditEntry(makeAuditEntry({ amount: String(i) }))
        )
      );

      const log = await storage.getAuditLog();
      let prev = AUDIT_GENESIS_HASH;
      for (const row of log) {
        expect(row.prevHash).toBe(prev);
        prev = row.hash;
      }
      expect(log).toHaveLength(5);
    });
  });

  describe('agent state', () => {
    it('returns undefined for a key that was never set', async () => {
      expect(await storage.loadAgentState('paused')).toBeUndefined();
    });

    it('replaces an existing value', async () => {
      await storage.saveAgentState('paused', 'true');
      await storage.saveAgentState('paused', 'false');

      expect(await storage.loadAgentState('paused')).toBe('false');
    });
  });

  describe('spending window', () => {
    it('saves, loads, prunes and clears records', async () => {
      await storage.saveSpendingRecord({ amount: 1.5, timestamp: 1_000 });
      await storage.saveSpendingRecord({ amount: 2.5, timestamp: 2_000 });

      expect(await storage.loadSpendingRecords(1_500)).toEqual([
        { amount: 2.5, timestamp: 2_000 },
      ]);

      await storage.pruneSpendingRecords(1_500);
      expect(await storage.loadSpendingRecords(0)).toEqual([{ amount: 2.5, timestamp: 2_000 }]);

      await storage.clearSpendingRecords();
      expect(await storage.loadSpendingRecords(0)).toEqual([]);
    });

    it('reserves within the limit and rejects past it without writing', async () => {
      const first = await storage.reserveSpending(60, 100, 0, 1_000);
      expect(first.total).toBe(60);

      await expect(storage.reserveSpending(50, 100, 0, 2_000)).rejects.toThrow(/exceeds limit/);
      expect(await storage.loadSpendingRecords(0)).toEqual([{ amount: 60, timestamp: 1_000 }]);
    });

    it('frees capacity when a reservation is released', async () => {
      const held = await storage.reserveSpending(80, 100, 0, 1_000);
      await storage.releaseSpending(held.id);

      await expect(storage.reserveSpending(80, 100, 0, 2_000)).resolves.toMatchObject({
        total: 80,
      });
    });

    it('ignores records older than the window', async () => {
      await storage.saveSpendingRecord({ amount: 90, timestamp: 1_000 });

      await expect(storage.reserveSpending(90, 100, 5_000, 6_000)).resolves.toMatchObject({
        total: 90,
      });
    });

    it('never lets concurrent reservations exceed the limit', async () => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 10 }, () => storage.reserveSpending(10, 50, 0, 1_000))
      );

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(5);
      const records = await storage.loadSpendingRecords(0);
      expect(records.reduce((sum, r) => sum + r.amount, 0)).toBe(50);
    });
  });

  describe('nonce store', () => {
    it('remembers used nonces and treats repeat adds as no-ops', async () => {
      const nonces = storage.nonceStore();

      expect(await nonces.has('nonce-1')).toBe(false);
      await nonces.add('nonce-1');
      await nonces.add('nonce-1');
      expect(await nonces.has('nonce-1')).toBe(true);
      expect(await nonces.has('nonce-2')).toBe(false);
    });
  });
});
