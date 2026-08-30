/**
 * tests/nonce_store.test.ts
 *
 * TTL eviction for the x402 nonce stores (#373).
 *
 * Replay protection only needs a nonce to outlive its challenge, so entries
 * past X402_NONCE_TTL_MS are evicted on access. These cover both that expired
 * nonces stop blocking and that unexpired ones still do.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const TTL_MS = 60_000;

vi.mock("../backend/config", () => ({
  config: {
    X402_NONCE_TTL_MS: 60_000,
  },
}));

import {
  InMemoryNonceStore,
  SqliteNonceStore,
  MAX_NONCE_TTL_MS,
} from "../backend/nonce_store";
import Database from "better-sqlite3";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemoryNonceStore TTL eviction", () => {
  it("keeps blocking a nonce that is still inside the TTL window", async () => {
    const store = new InMemoryNonceStore();
    await store.add("nonce-1");

    vi.advanceTimersByTime(TTL_MS - 1);

    expect(await store.has("nonce-1")).toBe(true);
  });

  it("stops blocking a nonce once the TTL has elapsed", async () => {
    const store = new InMemoryNonceStore();
    await store.add("nonce-1");

    vi.advanceTimersByTime(TTL_MS + 1);

    expect(await store.has("nonce-1")).toBe(false);
  });

  it("drops expired entries so the store stays bounded", async () => {
    const store = new InMemoryNonceStore();
    for (let i = 0; i < 50; i++) {
      await store.add(`old-${i}`);
    }
    expect(store.size).toBe(50);

    vi.advanceTimersByTime(TTL_MS + 1);
    await store.add("fresh");

    expect(store.size).toBe(1);
  });

  it("evicts on has() as well as add()", async () => {
    const store = new InMemoryNonceStore();
    await store.add("nonce-1");
    expect(store.size).toBe(1);

    vi.advanceTimersByTime(TTL_MS + 1);
    await store.has("unrelated");

    expect(store.size).toBe(0);
  });

  it("only evicts the entries that have actually expired", async () => {
    const store = new InMemoryNonceStore();
    await store.add("old");

    vi.advanceTimersByTime(TTL_MS - 1_000);
    await store.add("recent");

    vi.advanceTimersByTime(2_000); // "old" is past TTL, "recent" is not

    expect(await store.has("old")).toBe(false);
    expect(await store.has("recent")).toBe(true);
  });

  it("honours an explicit ttlMs argument over the configured value", async () => {
    const store = new InMemoryNonceStore();
    await store.add("nonce-1");

    vi.advanceTimersByTime(5_000);
    await store.prune(1_000);

    expect(store.size).toBe(0);
  });
});

describe("SqliteNonceStore TTL eviction", () => {
  it("stops blocking a nonce once the TTL has elapsed", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNonceStore(db);

    await store.add("nonce-1");
    expect(await store.has("nonce-1")).toBe(true);

    vi.advanceTimersByTime(TTL_MS + 1);

    expect(await store.has("nonce-1")).toBe(false);
    db.close();
  });

  it("removes expired rows rather than merely hiding them", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNonceStore(db);

    await store.add("nonce-1");
    vi.advanceTimersByTime(TTL_MS + 1);
    await store.add("nonce-2");

    const rows = db
      .prepare("SELECT nonce FROM x402_used_nonces")
      .all() as { nonce: string }[];
    expect(rows.map((r) => r.nonce)).toEqual(["nonce-2"]);
    db.close();
  });

  it("keeps an unexpired nonce blocked", async () => {
    const db = new Database(":memory:");
    const store = new SqliteNonceStore(db);

    await store.add("nonce-1");
    vi.advanceTimersByTime(TTL_MS - 1);

    expect(await store.has("nonce-1")).toBe(true);
    db.close();
  });
});

describe("MAX_NONCE_TTL_MS", () => {
  it("still exposes the 24 hour default", () => {
    expect(MAX_NONCE_TTL_MS).toBe(24 * 60 * 60 * 1_000);
  });
});
