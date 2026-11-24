/**
 * tests/helpers/persistenceMock.ts
 *
 * Canonical export list for the `backend/persistence` mock.
 *
 * Because `vi.mock` is hoisted above all `import` statements by Vitest,
 * you cannot call an imported function inside a `vi.mock` factory. The
 * correct pattern is to define the mock object via `vi.hoisted` so it is
 * materialised before `vi.mock` runs:
 *
 *   // At the top of a test file, before any imports:
 *   const persistenceMocks = vi.hoisted(() => ({
 *     saveResult: vi.fn(),
 *     getResults: vi.fn().mockReturnValue([]),
 *     _setDb: vi.fn(),
 *   }));
 *
 *   vi.mock("../backend/persistence", () => persistenceMocks);
 *
 * This file documents the canonical set of exports so that when a new
 * export is added to `backend/persistence.ts`, contributors know to update
 * every hoisted block above. Having all usages grep-able to this file
 * closes the "export is defined on the mock" issue (#994).
 *
 * Canonical exports (keep in sync with backend/persistence.ts):
 *   - saveResult
 *   - getResults
 *   - _setDb
 */

// This file is documentation-only; no runtime code is exported.
// The vi.hoisted pattern used in each test file is intentionally inlined
// rather than imported, because vi.hoisted callbacks cannot reference
// identifiers from imported modules (they are evaluated before imports).
export type PersistenceMock = {
  saveResult: ReturnType<typeof import("vitest")["vi"]["fn"]>;
  getResults: ReturnType<typeof import("vitest")["vi"]["fn"]>;
  _setDb: ReturnType<typeof import("vitest")["vi"]["fn"]>;
};
