/**
 * tests/spending_tracker_persistence.test.ts
 *
 * Tests for Issue #731: SpendingTracker.rollback() must delete the persisted
 * row so rolled-back spend does not reappear after a process restart.
 *
 * Uses an in-memory SQLite DB injected via _setDb() to stay hermetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { _setDb, getSpendingRecordsSince } from "../backend/persistence";
import { SpendingTracker } from "../backend/spending_tracker";

// ─── Mock config ──────────────────────────────────────────────────────────────
vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    AGENT_SPENDING_LIMIT: "1000",
    SPENDING_LIMITS_MAP: new Map<string, string>(),
    SPENDING_LIMITS_ALLOW_UNKNOWN: true,
    SPENDING_WINDOW_MS: 86_400_000,
    agentKeypair: () => ({ secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73" }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  return db; // _setDb will call initSchema
}

function cutoffIso(): string {
  return new Date(Date.now() - 86_400_000).toISOString();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SpendingTracker — rollback deletes persisted row (issue #731)", () => {
  let tracker: SpendingTracker;

  beforeEach(() => {
    _setDb(makeInMemoryDb());
    tracker = new SpendingTracker(86_400_000);
  });

  it("rollback + restart: rolled-back amount is excluded from total", () => {
    // Reserve and immediately roll back
    const id = tracker.reserve("50", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
    expect(tracker.totalForAsset("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")).toBe(500_000_000n); // 50 * 1e7

    tracker.rollback(id);
    // In-memory total should be 0 after rollback
    expect(tracker.totalForAsset("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")).toBe(0n);

    // Simulate restart: fresh tracker restores from DB
    const trackerAfterRestart = new SpendingTracker(86_400_000);
    trackerAfterRestart.restore();

    // The rolled-back row was deleted — total must still be 0
    expect(trackerAfterRestart.totalForAsset("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")).toBe(0n);
  });

  it("commit + restart: committed amount IS restored", () => {
    const id = tracker.reserve("100", "XLM");
    tracker.commit(id);
    expect(tracker.totalForAsset("XLM")).toBe(1_000_000_000n); // 100 * 1e7

    // Simulate restart
    const trackerAfterRestart = new SpendingTracker(86_400_000);
    trackerAfterRestart.restore();

    // Committed row is still in DB — total should be restored
    expect(trackerAfterRestart.totalForAsset("XLM")).toBe(1_000_000_000n);
  });

  it("rollback removes the row from spending_records table", () => {
    const id = tracker.reserve("75", "XLM");

    // Row should exist in DB
    const rowsBefore = getSpendingRecordsSince(cutoffIso());
    expect(rowsBefore.some((r) => r.id === id)).toBe(true);

    tracker.rollback(id);

    // Row should be gone from DB
    const rowsAfter = getSpendingRecordsSince(cutoffIso());
    expect(rowsAfter.some((r) => r.id === id)).toBe(false);
  });

  it("rollback is idempotent — second rollback does not throw", () => {
    const id = tracker.reserve("10", "XLM");
    tracker.rollback(id);
    // Second rollback on same id should not throw
    expect(() => tracker.rollback(id)).not.toThrow();
  });

  it("multiple commits accumulate correctly after restore", () => {
    tracker.commit(tracker.reserve("100", "XLM"));
    tracker.commit(tracker.reserve("200", "XLM"));

    const trackerAfterRestart = new SpendingTracker(86_400_000);
    trackerAfterRestart.restore();

    // 300 XLM = 3_000_000_000 stroops
    expect(trackerAfterRestart.totalForAsset("XLM")).toBe(3_000_000_000n);
 * Issue #372 — the rolling spending window has to survive a process restart.
 *
 * The tracker used to hold its records in memory only, so restarting the agent
 * reset the cumulative total to zero and the cap could be walked past by
 * restarting between payments. A "restart" here is a second SpendingTracker
 * built over the same database.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../backend/config', () => ({
  config: {
    SPENDING_WINDOW_MS: 60_000,
    AGENT_SPENDING_LIMIT: '100',
    DB_PATH: ':memory:',
  },
}));

import { SpendingTracker } from '../backend/spending_tracker';
import { _setDb, loadSpendingRecords, clearSpendingRecords } from '../backend/persistence';

const WINDOW_MS = 60_000;

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  db = new Database(':memory:');
  _setDb(db);
  clearSpendingRecords();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe('SpendingTracker persistence', () => {
  it('writes each recorded payment to the database', () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record('40');

    expect(loadSpendingRecords(0)).toHaveLength(1);
    expect(loadSpendingRecords(0)[0]!.amount).toBe(40);
  });

  it('picks up prior window spend on construction', () => {
    const first = new SpendingTracker(WINDOW_MS);
    first.record('40');
    expect(first.total()).toBe(40);

    // A restart: same database, brand new tracker.
    const second = new SpendingTracker(WINDOW_MS);

    expect(second.total()).toBe(40);
  });

  it('keeps enforcing the cap across a restart', () => {
    const first = new SpendingTracker(WINDOW_MS);
    first.record('70');

    const second = new SpendingTracker(WINDOW_MS);

    // 70 + 40 = 110, past the limit of 100. Before persistence the restart
    // reset the total to zero and this went through.
    expect(() => second.record('40')).toThrow(/exceeds limit/);
  });

  it('accumulates across several restarts', () => {
    new SpendingTracker(WINDOW_MS).record('30');
    new SpendingTracker(WINDOW_MS).record('30');
    const third = new SpendingTracker(WINDOW_MS);
    third.record('30');

    expect(third.total()).toBe(90);
  });

  it('does not restore spend that has aged out of the window', () => {
    const first = new SpendingTracker(WINDOW_MS);
    first.record('40');

    vi.advanceTimersByTime(WINDOW_MS + 1);

    expect(new SpendingTracker(WINDOW_MS).total()).toBe(0);
  });

  it('restores only the part of the window still live', () => {
    const first = new SpendingTracker(WINDOW_MS);
    first.record('40');

    vi.advanceTimersByTime(WINDOW_MS - 1_000);
    first.record('25');

    vi.advanceTimersByTime(2_000); // the first payment has now aged out

    expect(new SpendingTracker(WINDOW_MS).total()).toBe(25);
  });

  it('clear() empties the persisted window too', () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record('40');
    tracker.clear();

    expect(loadSpendingRecords(0)).toHaveLength(0);
    expect(new SpendingTracker(WINDOW_MS).total()).toBe(0);
  });

  it('evicts aged-out rows rather than letting the table grow forever', () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record('10');

    vi.advanceTimersByTime(WINDOW_MS + 1);
    tracker.record('10');

    expect(loadSpendingRecords(0)).toHaveLength(1);
  });
});
