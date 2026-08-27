/**
 * tests/spending_tracker_persistence.test.ts
 *
 * Issue #372 — the rolling spending window has to survive a process restart.
 *
 * The tracker used to hold its records in memory only, so restarting the agent
 * reset the cumulative total to zero and the cap could be walked past by
 * restarting between payments. A "restart" here is a second SpendingTracker
 * built over the same database.
 */

import Database from "better-sqlite3";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../backend/config", () => ({
  config: {
    SPENDING_WINDOW_MS: 60_000,
    AGENT_SPENDING_LIMIT: "100",
    DB_PATH: ":memory:",
  },
}));

import { SpendingTracker } from "../backend/spending_tracker";
import {
  _setDb,
  loadSpendingRecords,
  clearSpendingRecords,
} from "../backend/persistence";

const WINDOW_MS = 60_000;

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  db = new Database(":memory:");
  _setDb(db);
  clearSpendingRecords();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("SpendingTracker persistence", () => {
  it("writes each recorded payment to the database", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("40");

    expect(loadSpendingRecords(0)).toHaveLength(1);
    expect(loadSpendingRecords(0)[0]!.amount).toBe(40);
  });

  it("picks up prior window spend on construction", () => {
    const first = new SpendingTracker(WINDOW_MS);
    first.record("40");
    expect(first.total()).toBe(40);

    // A restart: same database, brand new tracker.
    const second = new SpendingTracker(WINDOW_MS);

    expect(second.total()).toBe(40);
  });

  it("keeps enforcing the cap across a restart", () => {
    const first = new SpendingTracker(WINDOW_MS);
    first.record("70");

    const second = new SpendingTracker(WINDOW_MS);

    // 70 + 40 = 110, past the limit of 100. Before persistence the restart
    // reset the total to zero and this went through.
    expect(() => second.record("40")).toThrow(/exceeds limit/);
  });

  it("accumulates across several restarts", () => {
    new SpendingTracker(WINDOW_MS).record("30");
    new SpendingTracker(WINDOW_MS).record("30");
    const third = new SpendingTracker(WINDOW_MS);
    third.record("30");

    expect(third.total()).toBe(90);
  });

  it("does not restore spend that has aged out of the window", () => {
    const first = new SpendingTracker(WINDOW_MS);
    first.record("40");

    vi.advanceTimersByTime(WINDOW_MS + 1);

    expect(new SpendingTracker(WINDOW_MS).total()).toBe(0);
  });

  it("restores only the part of the window still live", () => {
    const first = new SpendingTracker(WINDOW_MS);
    first.record("40");

    vi.advanceTimersByTime(WINDOW_MS - 1_000);
    first.record("25");

    vi.advanceTimersByTime(2_000); // the first payment has now aged out

    expect(new SpendingTracker(WINDOW_MS).total()).toBe(25);
  });

  it("clear() empties the persisted window too", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("40");
    tracker.clear();

    expect(loadSpendingRecords(0)).toHaveLength(0);
    expect(new SpendingTracker(WINDOW_MS).total()).toBe(0);
  });

  it("evicts aged-out rows rather than letting the table grow forever", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("10");

    vi.advanceTimersByTime(WINDOW_MS + 1);
    tracker.record("10");

    expect(loadSpendingRecords(0)).toHaveLength(1);
  });
});
