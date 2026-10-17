import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SpendingTracker } from '../backend/spending_tracker';

/**
 * Tests for SpendingTracker covering:
 *
 * Issue #243  — original window-boundary behaviour (all existing cases kept)
 * Issue #730  — over-limit attempt must NOT mutate state; rejected amount must
 *               not appear in total() or be persisted.
 * Issue #729  — reserve/commit/release three-phase API: failed payments must
 *               not count toward the window; successful payments must count
 *               exactly once; reservations are visible in totalWithReserved().
 */

vi.mock('../backend/config', () => ({
  config: {
    SPENDING_WINDOW_MS: 60_000,
    AGENT_SPENDING_LIMIT: '100',
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Existing window-boundary tests (#243) ────────────────────────────────────

describe("SpendingTracker window boundary", () => {
const WINDOW_MS = 60_000; // 1 minute — passed explicitly to each tracker

// ─── Basic record / limit checks ─────────────────────────────────────────────

describe('SpendingTracker — basic record and limit checks', () => {
  let tracker: SpendingTracker;

  beforeEach(() => {
    tracker = new SpendingTracker(WINDOW_MS);
  });

  it('starts with a zero total', () => {
    expect(tracker.total()).toBe(0);
  });

  it('accumulates amounts correctly', () => {
    tracker.record('10');
    tracker.record('25.5');
    expect(tracker.total()).toBeCloseTo(35.5);
  });

  it('throws when cumulative total exceeds the spending limit', () => {
    // limit = '100' from mocked config
    tracker.record('90');
    expect(() => tracker.record('20')).toThrow(/Cumulative spending.*exceeds limit/);
  });

  it('does not throw when cumulative total equals the limit exactly', () => {
    expect(() => tracker.record('100')).not.toThrow();
  });

  it('ignores NaN / non-numeric strings gracefully', () => {
    expect(() => tracker.record('not-a-number')).not.toThrow();
    expect(tracker.total()).toBe(0);
  });

  it('ignores empty string without throwing', () => {
    expect(() => tracker.record('')).not.toThrow();
  });
});

// ─── getWindowStatus ─────────────────────────────────────────────────────────

describe('SpendingTracker — getWindowStatus()', () => {
  let tracker: SpendingTracker;

  beforeEach(() => {
    tracker = new SpendingTracker(WINDOW_MS);
  });

  it('returns zero total and null oldestTimestamp when no records exist', () => {
    const status = tracker.getWindowStatus();
    expect(status.total).toBe(0);
    expect(status.recordCount).toBe(0);
    expect(status.windowMs).toBe(WINDOW_MS);
    expect(status.oldestTimestamp).toBeNull();
  });

  it('reflects recorded amounts in total and recordCount', () => {
    tracker.record('30');
    tracker.record('20');
    const status = tracker.getWindowStatus();
    expect(status.total).toBeCloseTo(50);
    expect(status.recordCount).toBe(2);
  });

  it('oldestTimestamp matches the timestamp of the first record', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    tracker.record('10');
    vi.setSystemTime(1_001_000);
    tracker.record('5');

    const status = tracker.getWindowStatus();
    expect(status.oldestTimestamp).toBe(1_000_000);
    vi.useRealTimers();
  });
});

// ─── Rolling window expiry with fake timers ───────────────────────────────────

describe('SpendingTracker — rolling window expiry (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('total() returns 0 for an empty tracker', () => {
    expect(new SpendingTracker(WINDOW_MS).total()).toBe(0);
  });

  it('cumulative total resets after the window expires', () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record('40');
    expect(tracker.total()).toBe(40);

    vi.advanceTimersByTime(WINDOW_MS + 1);

    expect(tracker.total()).toBe(0);
  });

  it('payments at exactly the boundary edge are pruned', () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record('40');

    vi.advanceTimersByTime(WINDOW_MS);
    expect(tracker.total()).toBe(40);

    vi.advanceTimersByTime(1);
    expect(tracker.total()).toBe(0);
  });

  it('throws when the cumulative total exceeds the limit mid-window', () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record('60');
    vi.advanceTimersByTime(1_000);

    expect(() => tracker.record("50")).toThrow(/exceeds limit/);
    // 60 + 50 = 110 > 100, and both are inside the window.
    expect(() => tracker.record('50')).toThrow(/exceeds limit/);
  });

  it('allows the same spend again once the window has rolled over', () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record('60');

    vi.advanceTimersByTime(WINDOW_MS + 1);

    expect(() => tracker.record("60")).not.toThrow();
    // This is the evasion the issue is about: spacing payments across the
    // boundary is *allowed by design*, but only because the earlier one has
    // genuinely expired — not because pruning lost track of it.
    expect(() => tracker.record('60')).not.toThrow();
    expect(tracker.total()).toBe(60);
  });

  it('counts only the records still inside the window', () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record('30');
    vi.advanceTimersByTime(WINDOW_MS / 2);
    tracker.record('30');

    vi.advanceTimersByTime(WINDOW_MS / 2 + 1);
    expect(tracker.total()).toBe(30);
  });

  it('ignores non-numeric amounts without disturbing the total', () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record('25');
    tracker.record('not-a-number');
    expect(tracker.total()).toBe(25);
  });
});

// ─── Issue #730: over-limit rejection must not mutate state ──────────────────

describe("SpendingTracker #730 — over-limit attempt leaves state unchanged", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("total() is unchanged after an over-limit record() call", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("60");
    expect(tracker.total()).toBe(60);

    // 60 + 50 = 110 > 100 — should throw
    expect(() => tracker.record("50")).toThrow(/exceeds limit/);

    // total must still be 60, not 110
    expect(tracker.total()).toBe(60);
  });

  it("a blocked attempt does not lock the tracker for subsequent valid records", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("60");

    // This should be blocked
    expect(() => tracker.record("50")).toThrow(/exceeds limit/);

    // A smaller record that still fits (60 + 30 = 90 ≤ 100) should succeed
    expect(() => tracker.record("30")).not.toThrow();
    expect(tracker.total()).toBe(90);
  });

  it("multiple consecutive over-limit attempts do not inflate total()", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("80");

    // Attempt to push over the limit three times
    for (let i = 0; i < 3; i++) {
      expect(() => tracker.record("30")).toThrow(/exceeds limit/);
    }

    // total must still be 80
    expect(tracker.total()).toBe(80);
  });

  it("nothing is written to committed records on rejection", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("60");

    try {
      tracker.record("50");
    } catch {
      // expected
    }

    // After the window expires, total resets to 0, not the rejected amount
    vi.advanceTimersByTime(WINDOW_MS + 1);
    expect(tracker.total()).toBe(0);
  });
});

// ─── Issue #729: reserve / commit / release ───────────────────────────────────

describe("SpendingTracker #729 — reserve/commit/release three-phase API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── reserve ────────────────────────────────────────────────────────────────

  it("reserve() returns a unique string id", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    const id1 = tracker.reserve("30");
    const id2 = tracker.reserve("20");
    expect(typeof id1).toBe("string");
    expect(typeof id2).toBe("string");
    expect(id1).not.toBe(id2);
  });

  it("reserve() counts the amount in totalWithReserved() but not total()", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.reserve("40");
    expect(tracker.total()).toBe(0);
    expect(tracker.totalWithReserved()).toBe(40);
  });

  it("reserve() throws if the prospective total would exceed the limit", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.reserve("80");

    expect(() => tracker.reserve("30")).toThrow(/exceeds limit/);
    // Only the first reservation is held
    expect(tracker.totalWithReserved()).toBe(80);
  });

  it("reserve() throws for non-numeric input", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    expect(() => tracker.reserve("not-a-number")).toThrow();
  });

  // ── commit ─────────────────────────────────────────────────────────────────

  it("commit() converts the reservation into a committed record", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    const id = tracker.reserve("40");

    tracker.commit(id);

    expect(tracker.total()).toBe(40);
    expect(tracker.totalWithReserved()).toBe(40);
  });

  it("successful payments count exactly once after commit", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    const id = tracker.reserve("40");
    tracker.commit(id);

    // total() should count it once, not twice
    expect(tracker.total()).toBe(40);
  });

  it("commit() throws for an unknown reservation id", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    expect(() => tracker.commit("nonexistent-id")).toThrow(/No active reservation/);
  });

  it("commit() throws if called twice for the same id", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    const id = tracker.reserve("30");
    tracker.commit(id);
    expect(() => tracker.commit(id)).toThrow(/No active reservation/);
  });

  // ── release ────────────────────────────────────────────────────────────────

  it("release() removes the reservation and does NOT count toward total()", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    const id = tracker.reserve("60");

    // Simulate transaction failure
    tracker.release(id);

    expect(tracker.total()).toBe(0);
    expect(tracker.totalWithReserved()).toBe(0);
  });

  it("failed payments do not count toward the window after release", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("60"); // committed spend

    const id = tracker.reserve("30"); // provisional
    tracker.release(id);              // tx failed

    // Only the committed 60 should count
    expect(tracker.total()).toBe(60);
    expect(tracker.totalWithReserved()).toBe(60);
  });

  it("release() allows the amount to be reserved again after failure", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.record("60");
    const id = tracker.reserve("30");
    tracker.release(id);

    // The same 30 can now be reserved again (60 + 30 = 90 ≤ 100)
    expect(() => tracker.reserve("30")).not.toThrow();
  });

  it("release() throws for an unknown reservation id", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    expect(() => tracker.release("nonexistent-id")).toThrow(/No active reservation/);
  });

  it("release() throws if called twice for the same id", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    const id = tracker.reserve("30");
    tracker.release(id);
    expect(() => tracker.release(id)).toThrow(/No active reservation/);
  });

  // ── combined flows ─────────────────────────────────────────────────────────

  it("multiple concurrent reservations are all held against the limit", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.reserve("40");
    tracker.reserve("40"); // 80 reserved total

    // 80 + 30 = 110 > 100
    expect(() => tracker.reserve("30")).toThrow(/exceeds limit/);
    expect(tracker.totalWithReserved()).toBe(80);
  });

  it("committed record persists across the window while unreserved amount is freed", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    const id1 = tracker.reserve("50");
    const id2 = tracker.reserve("30");

    tracker.commit(id1); // 50 committed
    tracker.release(id2); // 30 released (tx failed)

    expect(tracker.total()).toBe(50);
    expect(tracker.totalWithReserved()).toBe(50);
  });

  it("stale reservations are pruned after the window expires", () => {
    const tracker = new SpendingTracker(WINDOW_MS);
    tracker.reserve("80"); // never committed or released

    // Advance past the window
    vi.advanceTimersByTime(WINDOW_MS + 1);

    // Pruning occurs on the next call; the stale hold must be gone
    expect(tracker.totalWithReserved()).toBe(0);
    // A new reservation for 80 should succeed (limit = 100)
    expect(() => tracker.reserve("80")).not.toThrow();
  });
});
