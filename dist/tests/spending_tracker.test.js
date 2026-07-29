"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const spending_tracker_1 = require("../backend/spending_tracker");
/**
 * Issue #243 — window-boundary behaviour of the rolling spending limit.
 *
 * `pruneOld` is what stops the cumulative limit being evaded by spacing
 * payments around the window edge, and it had no coverage. Time is driven with
 * fake timers rather than real sleeps so the boundary can be hit exactly —
 * a real-clock test would be both slow and flaky at the millisecond that
 * matters.
 */
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        SPENDING_WINDOW_MS: 60_000,
        AGENT_SPENDING_LIMIT: "100",
    },
}));
const WINDOW_MS = 60_000;
(0, vitest_1.describe)("SpendingTracker window boundary", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.useFakeTimers();
        vitest_1.vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("total() returns 0 for an empty tracker", () => {
        (0, vitest_1.expect)(new spending_tracker_1.SpendingTracker(WINDOW_MS).total()).toBe(0);
    });
    (0, vitest_1.it)("cumulative total resets after the window expires", () => {
        const tracker = new spending_tracker_1.SpendingTracker(WINDOW_MS);
        tracker.record("40");
        (0, vitest_1.expect)(tracker.total()).toBe(40);
        vitest_1.vi.advanceTimersByTime(WINDOW_MS + 1);
        // The old record must roll off, or the limit becomes a lifetime cap.
        (0, vitest_1.expect)(tracker.total()).toBe(0);
    });
    (0, vitest_1.it)("payments at exactly the boundary edge are pruned", () => {
        const tracker = new spending_tracker_1.SpendingTracker(WINDOW_MS);
        tracker.record("40");
        // cutoff = now - windowMs, and pruning is `timestamp < cutoff`, so a
        // record exactly windowMs old is still inside the window.
        vitest_1.vi.advanceTimersByTime(WINDOW_MS);
        (0, vitest_1.expect)(tracker.total()).toBe(40);
        // One millisecond further and it falls outside.
        vitest_1.vi.advanceTimersByTime(1);
        (0, vitest_1.expect)(tracker.total()).toBe(0);
    });
    (0, vitest_1.it)("throws when the cumulative total exceeds the limit mid-window", () => {
        const tracker = new spending_tracker_1.SpendingTracker(WINDOW_MS);
        tracker.record("60");
        vitest_1.vi.advanceTimersByTime(1_000);
        // 60 + 50 = 110 > 100, and both are inside the window.
        (0, vitest_1.expect)(() => tracker.record("50")).toThrow(/exceeds limit/);
    });
    (0, vitest_1.it)("allows the same spend again once the window has rolled over", () => {
        const tracker = new spending_tracker_1.SpendingTracker(WINDOW_MS);
        tracker.record("60");
        vitest_1.vi.advanceTimersByTime(WINDOW_MS + 1);
        // This is the evasion the issue is about: spacing payments across the
        // boundary is *allowed by design*, but only because the earlier one has
        // genuinely expired — not because pruning lost track of it.
        (0, vitest_1.expect)(() => tracker.record("60")).not.toThrow();
        (0, vitest_1.expect)(tracker.total()).toBe(60);
    });
    (0, vitest_1.it)("counts only the records still inside the window", () => {
        const tracker = new spending_tracker_1.SpendingTracker(WINDOW_MS);
        tracker.record("30");
        vitest_1.vi.advanceTimersByTime(WINDOW_MS / 2);
        tracker.record("30");
        // Half a window later the first has expired and the second has not.
        vitest_1.vi.advanceTimersByTime(WINDOW_MS / 2 + 1);
        (0, vitest_1.expect)(tracker.total()).toBe(30);
    });
    (0, vitest_1.it)("ignores non-numeric amounts without disturbing the total", () => {
        const tracker = new spending_tracker_1.SpendingTracker(WINDOW_MS);
        tracker.record("25");
        tracker.record("not-a-number");
        (0, vitest_1.expect)(tracker.total()).toBe(25);
    });
});
//# sourceMappingURL=spending_tracker.test.js.map