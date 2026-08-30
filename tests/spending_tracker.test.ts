/**
 * tests/spending_tracker.test.ts
 *
 * Tests for SpendingTracker — covers basic record/limit checks and rolling
 * window expiry behaviour using Vitest fake timers.
 *
 * Issue #447: Add SpendingTracker rolling window expiry tests with fake timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpendingTracker } from "../backend/spending_tracker";

// ─── Config mock ──────────────────────────────────────────────────────────────
// SpendingTracker imports config only for the default constructor argument.
// We supply the window duration explicitly in every test so this mock is a
// safety-net that prevents the real loadConfig() from running.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SpendingTracker } from "../backend/spending_tracker";

/**
 * Issue #243 — window-boundary behaviour of the rolling spending limit.
 *
 * `pruneOld` is what stops the cumulative limit being evaded by spacing
 * payments around the window edge, and it had no coverage. Time is driven with
 * fake timers rather than real sleeps so the boundary can be hit exactly —
 * a real-clock test would be both slow and flaky at the millisecond that
 * matters.
 */

vi.mock("../backend/config", () => ({
  config: {
    SPENDING_WINDOW_MS: 60_000,
    AGENT_SPENDING_LIMIT: "100",
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WINDOW_MS = 60_000; // 1 minute — passed explicitly to each tracker

// ─── Basic record / limit checks ─────────────────────────────────────────────

describe("SpendingTracker — basic record and limit checks", () => {
  let tracker: SpendingTracker;

  beforeEach(() => {
    tracker = new SpendingTracker(WINDOW_MS);
  });

  it("starts with a zero total", () => {
    expect(tracker.total()).toBe(0);
  });

  it("accumulates amounts correctly", () => {
    tracker.record("10");
    tracker.record("25.5");
    expect(tracker.total()).toBeCloseTo(35.5);
  });

  it("throws when cumulative total exceeds the spending limit", () => {
    // limit = '100' from mocked config
    tracker.record("90");
    expect(() => tracker.record("20")).toThrow(/Cumulative spending.*exceeds limit/);
  });

  it("does not throw when cumulative total equals the limit exactly", () => {
    expect(() => tracker.record("100")).not.toThrow();
  });

  it("ignores NaN / non-numeric strings gracefully", () => {
    expect(() => tracker.record("not-a-number")).not.toThrow();
    expect(tracker.total()).toBe(0);
  });

  it("ignores empty string without throwing", () => {
    expect(() => tracker.record("")).not.toThrow();
  });
});

// ─── getWindowStatus ─────────────────────────────────────────────────────────

describe("SpendingTracker — getWindowStatus()", () => {
  let tracker: SpendingTracker;

  beforeEach(() => {
    tracker = new SpendingTracker(WINDOW_MS);
  });

  it("returns zero total and null oldestTimestamp when no records exist", () => {
    const status = tracker.getWindowStatus();
    expect(status.total).toBe(0);
    expect(status.recordCount).toBe(0);
    expect(status.windowMs).toBe(WINDOW_MS);
    expect(status.oldestTimestamp).toBeNull();
  });

  it("reflects recorded amounts in total and recordCount", () => {
    tracker.record("30");
    tracker.record("20");
    const status = tracker.getWindowStatus();
    expect(status.total).toBeCloseTo(50);
    expect(status.recordCount).toBe(2);
  });

  it("oldestTimestamp matches the timestamp of the first record", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    tracker.record("10");
    vi.setSystemTime(1_001_000);
    tracker.record("5");

    const status = tracker.getWindowStatus();
    expect(status.oldestTimestamp).toBe(1_000_000);
    vi.useRealTimers();
  });
});

// ─── Rolling window expiry with fake timers ───────────────────────────────────

describe("SpendingTracker — rolling window expiry (fake timers)", () => {
  let tracker: SpendingTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = new SpendingTracker(WINDOW_MS);
const WINDOW_MS = 60_000;

describe("SpendingTracker window boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Core expiry behaviour ─────────────────────────────────────────────────

  it("cumulative total resets after advancing time past the window", () => {
    // Record near the limit inside the window
    vi.setSystemTime(0);
    tracker.record("80");
    expect(tracker.total()).toBeCloseTo(80);

    // Advance past the full window duration — the record should expire
    vi.advanceTimersByTime(WINDOW_MS + 1);

    // Total is now zero; a fresh record should succeed without throwing
    expect(tracker.total()).toBe(0);
    expect(() => tracker.record("80")).not.toThrow();
  });

  it("records within the window still block over-limit spending", () => {
    vi.setSystemTime(0);
    tracker.record("60");

    // Advance only half the window — record is still active
    vi.advanceTimersByTime(WINDOW_MS / 2);

    // 60 already recorded; trying to add 50 more would reach 110 > 100
    expect(() => tracker.record("50")).toThrow(/Cumulative spending.*exceeds limit/);
  });

  it("partial expiry: only records outside the window are pruned", () => {
    vi.setSystemTime(0);
    tracker.record("40"); // will expire after WINDOW_MS

    vi.advanceTimersByTime(WINDOW_MS / 2);
    tracker.record("30"); // still within window at t = WINDOW_MS + 1

    // Move to just past the window from t=0 — the first record expires,
    // the second (at t=WINDOW_MS/2) is still fresh
    vi.advanceTimersByTime(WINDOW_MS / 2 + 1);

    expect(tracker.total()).toBeCloseTo(30);
  });

  it("getWindowStatus() reflects expiry correctly after time advance", () => {
    vi.setSystemTime(0);
    tracker.record("50");

    // Before expiry
    let status = tracker.getWindowStatus();
    expect(status.total).toBeCloseTo(50);
    expect(status.recordCount).toBe(1);

    // Advance past window
    vi.advanceTimersByTime(WINDOW_MS + 1);

    // After expiry — window should be empty
    status = tracker.getWindowStatus();
    expect(status.total).toBe(0);
    expect(status.recordCount).toBe(0);
    expect(status.oldestTimestamp).toBeNull();
  });

  it("multiple windows: spend near limit, expire, spend near limit again", () => {
    // First window — record near the limit
    vi.setSystemTime(0);
    tracker.record("95");
    expect(() => tracker.record("10")).toThrow(/exceeds limit/);

    // Second window — advance past expiry, cumulative should reset
    vi.advanceTimersByTime(WINDOW_MS + 1);
    expect(tracker.total()).toBe(0);

    // Should be able to record near the limit again
    expect(() => tracker.record("95")).not.toThrow();
    expect(tracker.total()).toBeCloseTo(95);
  });

  it("exact boundary: record at t=0 expires at exactly t=WINDOW_MS+1", () => {
    vi.setSystemTime(0);
    tracker.record("70");

    // One millisecond before expiry — record is still active
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(tracker.total()).toBeCloseTo(70);

    // One millisecond past expiry — record should be pruned
    vi.advanceTimersByTime(2); // total advance = WINDOW_MS + 1
    expect(tracker.total()).toBe(0);
  });

  it("total() and getWindowStatus() agree after partial expiry", () => {
    vi.setSystemTime(0);
    tracker.record("20");

    vi.advanceTimersByTime(WINDOW_MS / 2);
    tracker.record("15");

    vi.advanceTimersByTime(WINDOW_MS / 2 + 1); // first record expires

    const total = tracker.total();
    const status = tracker.getWindowStatus();
    expect(status.total).toBeCloseTo(total);
    expect(status.recordCount).toBe(1);
  it("total() returns 0 for an empty tracker", () => {
    expect(new SpendingTracker(WINDOW_MS).total()).toBe(0);
  });

  it("cumulative total resets after the window expires", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("40");
    expect(tracker.total()).toBe(40);

    vi.advanceTimersByTime(WINDOW_MS + 1);

    // The old record must roll off, or the limit becomes a lifetime cap.
    expect(tracker.total()).toBe(0);
  });

  it("payments at exactly the boundary edge are pruned", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("40");

    // cutoff = now - windowMs, and pruning is `timestamp < cutoff`, so a
    // record exactly windowMs old is still inside the window.
    vi.advanceTimersByTime(WINDOW_MS);
    expect(tracker.total()).toBe(40);

    // One millisecond further and it falls outside.
    vi.advanceTimersByTime(1);
    expect(tracker.total()).toBe(0);
  });

  it("throws when the cumulative total exceeds the limit mid-window", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("60");
    vi.advanceTimersByTime(1_000);

    // 60 + 50 = 110 > 100, and both are inside the window.
    expect(() => tracker.record("50")).toThrow(/exceeds limit/);
  });

  it("allows the same spend again once the window has rolled over", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("60");

    vi.advanceTimersByTime(WINDOW_MS + 1);

    // This is the evasion the issue is about: spacing payments across the
    // boundary is *allowed by design*, but only because the earlier one has
    // genuinely expired — not because pruning lost track of it.
    expect(() => tracker.record("60")).not.toThrow();
    expect(tracker.total()).toBe(60);
  });

  it("counts only the records still inside the window", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("30");
    vi.advanceTimersByTime(WINDOW_MS / 2);
    tracker.record("30");

    // Half a window later the first has expired and the second has not.
    vi.advanceTimersByTime(WINDOW_MS / 2 + 1);
    expect(tracker.total()).toBe(30);
  });

  it("ignores non-numeric amounts without disturbing the total", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("25");
    tracker.record("not-a-number");
    expect(tracker.total()).toBe(25);
  });
});
