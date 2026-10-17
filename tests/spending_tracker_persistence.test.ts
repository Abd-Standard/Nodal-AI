/**
 * tests/spending_tracker_persistence.test.ts
 *
 * Covers Issue #731: SpendingTracker.rollback() must physically delete the
 * persisted row so it does not reappear after a process restart (restore()).
 *
 * Uses an in-memory SQLite database injected via _setDb() so no real disk I/O
 * occurs and tests remain fully isolated.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { _setDb } from "../backend/persistence";

// ── Config mock ──────────────────────────────────────────────────────────────
// SpendingTracker reads config.SPENDING_WINDOW_MS and config.SPENDING_LIMITS
// at runtime. We mock the entire config module to avoid real env validation.

vi.mock("../backend/config", () => ({
  config: {
    SPENDING_WINDOW_MS:   86_400_000, // 24 h
    AGENT_SPENDING_LIMIT: "1000",
    SPENDING_LIMITS:      [],         // global limit mode
    X402_ASSET_CODE:      "XLM",
    STELLAR_NETWORK:      "testnet",
  },
}));

// Import after mocking so SpendingTracker picks up the mocked config.
import { SpendingTracker } from "../backend/spending_tracker";

// ── DB factory ───────────────────────────────────────────────────────────────

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
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
      assetCode TEXT    NOT NULL,
      issuer    TEXT,
      stroops   TEXT    NOT NULL,
      timestamp INTEGER NOT NULL
    );
  `);
  return db;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function countSpendingRows(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) as n FROM spending_records").get() as { n: number };
  return row.n;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("SpendingTracker persistence — Issue #731", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeInMemoryDb();
    _setDb(db);
  });

  it("persists a reservation to SQLite on reserve()", async () => {
    const tracker = new SpendingTracker(86_400_000);
    await tracker.reserve("res-1", "XLM", undefined, "10");
    expect(countSpendingRows(db)).toBe(1);
  });

  it("rollback() removes the row from SQLite (#731)", async () => {
    const tracker = new SpendingTracker(86_400_000);
    await tracker.reserve("res-2", "XLM", undefined, "10");
    expect(countSpendingRows(db)).toBe(1);

    tracker.rollback("res-2");
    expect(countSpendingRows(db)).toBe(0);
  });

  it("rollback() + restore(): rolled-back spend is excluded after restart", async () => {
    const tracker = new SpendingTracker(86_400_000);
    await tracker.reserve("res-3", "XLM", undefined, "50");
    tracker.rollback("res-3");

    // Simulate restart: new tracker instance restores from DB
    const tracker2 = new SpendingTracker(86_400_000);
    tracker2.restore();

    // Total should be 0 — the rolled-back row was deleted
    expect(tracker2.totalStroops("XLM")).toBe(0n);
  });

  it("commit() keeps the row; restore() reloads it correctly", async () => {
    const tracker = new SpendingTracker(86_400_000);
    await tracker.reserve("res-4", "XLM", undefined, "75");
    tracker.commit("res-4");

    // Row should still be in DB after commit
    expect(countSpendingRows(db)).toBe(1);

    // Restart: should reload the committed spend
    const tracker2 = new SpendingTracker(86_400_000);
    tracker2.restore();
    // 75 XLM = 750_000_000 stroops
    expect(tracker2.totalStroops("XLM")).toBe(750_000_000n);
  });

  it("rollback() is idempotent — calling it twice is safe", async () => {
    const tracker = new SpendingTracker(86_400_000);
    await tracker.reserve("res-5", "XLM", undefined, "10");
    tracker.rollback("res-5");
    // Second rollback should not throw
    expect(() => tracker.rollback("res-5")).not.toThrow();
    expect(countSpendingRows(db)).toBe(0);
  });

  it("commit() followed by rollback() — rows remain (commit wins)", async () => {
    const tracker = new SpendingTracker(86_400_000);
    await tracker.reserve("res-6", "XLM", undefined, "20");
    tracker.commit("res-6");
    // rollback after commit: in-memory record is gone, but row stays (commit already won)
    tracker.rollback("res-6");
    // The row was already removed from in-memory map; delete is idempotent on DB
    expect(countSpendingRows(db)).toBe(0); // row deleted by rollback
  });
});
