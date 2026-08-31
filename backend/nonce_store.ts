/**
 * backend/nonce_store.ts
 *
 * INonceStore — pluggable nonce-persistence interface for X402PaymentTool.
 *
 * Replay protection requires that used nonces survive process restarts and
 * are shared across horizontal scale-out instances.  This module provides:
 *
 *   • INonceStore — the injectable interface
 *   • SqliteNonceStore — the default implementation backed by the existing
 *     SQLite database (same DB_PATH used by persistence.ts)
 *   • InMemoryNonceStore — lightweight in-process store for unit tests
 *
 * For multi-instance deployments, inject a custom INonceStore backed by a
 * shared store (e.g., Redis, DynamoDB) via the X402PaymentTool constructor.
 *
 * Nonce TTL
 * ---------
 * X402 challenges carry an `expiresAt` field.  Once a challenge has expired
 * it can never be replayed legitimately, so nonces older than the configured
 * TTL can be pruned.  The TTL comes from `X402_NONCE_TTL_MS` and defaults to
 * 24 hours — well above the expected maximum challenge lifetime — so no valid
 * nonce is discarded prematurely.
 *
 * Eviction runs on every has()/add() call, so a long-running agent's store stays
 * bounded by the TTL window without any caller having to schedule pruning.
 */

import Database from 'better-sqlite3';

import { config } from './config';

// Maximum age (ms) after which a stored nonce may be pruned.
// Set to 24 hours to cover the widest plausible challenge expiry window.
export const MAX_NONCE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Configured nonce lifetime, falling back to MAX_NONCE_TTL_MS when config has
 * not been loaded (unit tests frequently mock the config module wholesale).
 */
function configuredTtlMs(): number {
  const fromConfig = (config as { X402_NONCE_TTL_MS?: number } | undefined)?.X402_NONCE_TTL_MS;
  return typeof fromConfig === 'number' && fromConfig > 0 ? fromConfig : MAX_NONCE_TTL_MS;
}

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * Pluggable nonce-persistence contract for X402PaymentTool.
 *
 * Implementations MUST be safe to call concurrently from a single Node.js
 * event loop (i.e., individual method calls need not be re-entrant, but
 * they may be called in interleaved async contexts).
 */
export interface INonceStore {
  /**
   * Returns true if the nonce has been used before.
   * Implementations should not throw for missing nonces — return false.
   */
  has(nonce: string): Promise<boolean>;

  /**
   * Marks the nonce as used, recording the current timestamp for TTL pruning.
   * Calling add() for an already-present nonce is a no-op (idempotent).
   */
  add(nonce: string): Promise<void>;

  /**
   * Removes all nonces whose recorded timestamp is older than `ttlMs`
   * milliseconds ago.  Called opportunistically — callers must not rely on
   * pruning happening before or after any particular add()/has() call.
   *
   * @param ttlMs - Maximum age in milliseconds.  Defaults to MAX_NONCE_TTL_MS.
   */
  prune(ttlMs?: number): Promise<void>;
}

// ─── SQLite implementation ────────────────────────────────────────────────────

/**
 * SQLite-backed nonce store.  Uses the same database file as persistence.ts
 * (DB_PATH env var, default "./agent.db") so no extra infrastructure is
 * required.
 *
 * Schema (created lazily on first use):
 *   CREATE TABLE IF NOT EXISTS x402_used_nonces (
 *     nonce      TEXT PRIMARY KEY,
 *     used_at_ms INTEGER NOT NULL
 *   );
 *
 * All operations are synchronous at the SQLite level (better-sqlite3 API),
 * wrapped in Promise.resolve() to satisfy the async INonceStore interface
 * and keep call-sites uniform regardless of backend.
 */
export class SqliteNonceStore implements INonceStore {
  private db: Database.Database;
  private ready = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private ensureTable(): void {
    if (this.ready) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS x402_used_nonces (
        nonce      TEXT    PRIMARY KEY,
        used_at_ms INTEGER NOT NULL
      )
    `);
    // Index for efficient TTL pruning by timestamp.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_x402_nonces_used_at
        ON x402_used_nonces (used_at_ms)
    `);
    this.ready = true;
  }

  async has(nonce: string): Promise<boolean> {
    this.ensureTable();
    await this.prune();
    const row = this.db.prepare('SELECT 1 FROM x402_used_nonces WHERE nonce = ?').get(nonce);
    return row !== undefined;
  }

  async add(nonce: string): Promise<void> {
    this.ensureTable();
    await this.prune();
    this.db
      .prepare('INSERT OR IGNORE INTO x402_used_nonces (nonce, used_at_ms) VALUES (?, ?)')
      .run(nonce, Date.now());
  }

  async prune(ttlMs: number = configuredTtlMs()): Promise<void> {
    this.ensureTable();
    const cutoff = Date.now() - ttlMs;
    this.db.prepare('DELETE FROM x402_used_nonces WHERE used_at_ms < ?').run(cutoff);
  }
}

// ─── In-memory implementation (tests only) ───────────────────────────────────

/**
 * Lightweight in-memory nonce store for unit tests.
 *
 * Does NOT survive process restarts by design.  Use this only in test
 * environments where persistence is undesirable.
 */
export class InMemoryNonceStore implements INonceStore {
  private nonces = new Map<string, number>();

  async has(nonce: string): Promise<boolean> {
    await this.prune();
    return this.nonces.has(nonce);
  }

  async add(nonce: string): Promise<void> {
    await this.prune();
    if (!this.nonces.has(nonce)) {
      this.nonces.set(nonce, Date.now());
    }
  }

  /** Number of nonces currently retained. Exposed so tests can assert bounding. */
  get size(): number {
    return this.nonces.size;
  }

  async prune(ttlMs: number = configuredTtlMs()): Promise<void> {
    const cutoff = Date.now() - ttlMs;
    for (const [nonce, ts] of this.nonces) {
      if (ts < cutoff) {
        this.nonces.delete(nonce);
      }
    }
  }
}
