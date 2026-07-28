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

const WINDOW_MS = 60_000;

describe("SpendingTracker window boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
