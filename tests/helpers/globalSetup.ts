/**
 * tests/helpers/globalSetup.ts
 *
 * Vitest global setup file — registers suite-wide afterEach hooks that ensure
 * fake timers and spy state are always cleaned up between tests, regardless of
 * whether a test file remembered to call vi.useRealTimers() or
 * vi.restoreAllMocks() itself.
 *
 * Registered in vitest.config.ts under `test.setupFiles` so it runs
 * automatically before every test file.
 *
 * ## Why this is needed
 *
 * Individual test files currently call vi.useFakeTimers() and
 * vi.restoreAllMocks() inconsistently.  When a test file forgets to restore
 * real timers before it finishes, the fake timer state can leak into the next
 * file executed in the same worker thread — causing tests that rely on real
 * `setTimeout` / `setInterval` semantics (polling, retries, streams) to hang
 * or behave non-deterministically.
 *
 * This setup file addresses that by unconditionally resetting timer and spy
 * state after *every* test, giving each test a clean baseline.
 *
 * ## What it does
 *
 * afterEach — runs after every individual `it` / `test` block:
 *   1. vi.useRealTimers()   — restores the real timer implementation so that
 *      any `setTimeout`/`setInterval` calls in subsequent tests are not routed
 *      through fake timers left over from the previous test.
 *   2. vi.restoreAllMocks() — restores all mocked/spied functions to their
 *      original implementations.  This is a belt-and-suspenders complement to
 *      `restoreMocks: true` in vitest.config.ts; the config option fires at
 *      the Vitest level while this hook fires earlier in the test lifecycle,
 *      ensuring mocks are clean even inside deeply nested describe blocks.
 *
 * ## What it does NOT do
 *
 * - It does NOT call vi.clearAllMocks() — that is already handled by
 *   `clearMocks: true` in vitest.config.ts.
 * - It does NOT suppress intentional use of fake timers within a test.
 *   Calling vi.useFakeTimers() inside a test is still fully supported; this
 *   hook simply guarantees clean-up happens after that test finishes.
 * - It does NOT affect module mock registrations (vi.mock(…) calls at the top
 *   of a test file) — those are controlled by Vitest's module isolation layer
 *   and the `isolate: true` config option.
 */

import { afterEach, vi } from "vitest";

afterEach(() => {
  // Restore the real timer implementation after every test.
  // Guards against fake timer state leaking across tests when a test file
  // calls vi.useFakeTimers() but omits the matching vi.useRealTimers().
  vi.useRealTimers();

  // Restore all mocked / spied functions to their original implementations.
  // Belt-and-suspenders alongside restoreMocks: true in vitest.config.ts —
  // ensures cleanup happens even inside nested describe scopes.
  vi.restoreAllMocks();
});
