/**
 * tests/spending_tracker_concurrency.test.ts
 *
 * Covers Issue #732: with MAX_CONCURRENT_TASKS > 1, concurrent tasks must never
 * collectively exceed the spending limit — the check-and-reserve must be atomic.
 *
 * Fires 20 parallel reserve() calls of 10 units against a 100-unit limit.
 * Only 10 should succeed; the other 10 must be rejected.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { _setDb } from "../backend/persistence";

// ── Config mock ──────────────────────────────────────────────────────────────
// vi.mock is hoisted to top-of-file — keep the factory free of any outer variables.

vi.mock("../backend/config", () => ({
  config: {
    SPENDING_WINDOW_MS:   86_400_000,
    AGENT_SPENDING_LIMIT: "100",    // 100 units = 1_000_000_000 stroops
    SPENDING_LIMITS:      [],       // global limit mode for most tests
    X402_ASSET_CODE:      "XLM",
    STELLAR_NETWORK:      "testnet",
  },
}));

import { SpendingTracker } from "../backend/spending_tracker";

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

describe("SpendingTracker concurrency — Issue #732", () => {
  beforeEach(() => {
    _setDb(makeInMemoryDb());
  });

  it("20 parallel 10-unit reserves against a 100-unit limit: never exceeds limit", async () => {
    const tracker = new SpendingTracker(86_400_000);
    const PARALLELISM = 20;
    const AMOUNT = "10"; // each reservation is 10 units

    // Fire all 20 reservations concurrently
    const results = await Promise.allSettled(
      Array.from({ length: PARALLELISM }, (_, i) =>
        tracker.reserve(`concurrent-${i}`, "XLM", undefined, AMOUNT)
      )
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const rejected  = results.filter((r) => r.status === "rejected").length;

    // Exactly 10 should succeed (10 × 10 = 100 = limit)
    expect(succeeded).toBe(10);
    expect(rejected).toBe(10);

    // The in-window total must never exceed the limit (100 units = 1_000_000_000 stroops)
    expect(tracker.totalStroops("XLM")).toBeLessThanOrEqual(1_000_000_000n);
    expect(tracker.totalStroops("XLM")).toBe(1_000_000_000n); // exactly at limit
  });

  it("sequential reserves work normally without interference", async () => {
    const tracker = new SpendingTracker(86_400_000);

    await tracker.reserve("seq-1", "XLM", undefined, "30");
    await tracker.reserve("seq-2", "XLM", undefined, "30");
    await tracker.reserve("seq-3", "XLM", undefined, "30");

    // 90 units consumed; one more 10-unit reserve is fine
    await expect(tracker.reserve("seq-4", "XLM", undefined, "10")).resolves.toBeUndefined();

    // Now at 100 — next one must fail
    await expect(tracker.reserve("seq-5", "XLM", undefined, "1")).rejects.toThrow(/Cumulative/);
  });

  it("rollback frees capacity for subsequent reserves", async () => {
    const tracker = new SpendingTracker(86_400_000);

    await tracker.reserve("free-1", "XLM", undefined, "100");
    // At limit — cannot reserve more
    await expect(tracker.reserve("free-2", "XLM", undefined, "1")).rejects.toThrow(/Cumulative/);

    // Roll back the first reservation
    tracker.rollback("free-1");

    // Now we can reserve again
    await expect(tracker.reserve("free-3", "XLM", undefined, "50")).resolves.toBeUndefined();
  });

  it("two concurrent reservations that would together exceed the limit: only one succeeds", async () => {
    const tracker = new SpendingTracker(86_400_000);

    // Reserve 60 + 60 against a 100 limit — only one should win
    const [r1, r2] = await Promise.allSettled([
      tracker.reserve("race-1", "XLM", undefined, "60"),
      tracker.reserve("race-2", "XLM", undefined, "60"),
    ]);

    const successes = [r1, r2].filter((r) => r.status === "fulfilled").length;
    const failures  = [r1, r2].filter((r) => r.status === "rejected").length;

    expect(successes).toBe(1);
    expect(failures).toBe(1);
    expect(tracker.totalStroops("XLM")).toBe(600_000_000n); // 60 × 10_000_000
  });
});
