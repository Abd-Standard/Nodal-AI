"use strict";
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
 * it can never be replayed legitimately, so nonces older than
 * MAX_NONCE_TTL_MS can be pruned.  The default TTL is 24 hours — well above
 * the expected maximum challenge lifetime — so no valid nonce is discarded
 * prematurely.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryNonceStore = exports.SqliteNonceStore = exports.MAX_NONCE_TTL_MS = void 0;
// Maximum age (ms) after which a stored nonce may be pruned.
// Set to 24 hours to cover the widest plausible challenge expiry window.
exports.MAX_NONCE_TTL_MS = 24 * 60 * 60 * 1_000;
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
class SqliteNonceStore {
    db;
    ready = false;
    constructor(db) {
        this.db = db;
    }
    ensureTable() {
        if (this.ready)
            return;
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
    async has(nonce) {
        this.ensureTable();
        const row = this.db
            .prepare("SELECT 1 FROM x402_used_nonces WHERE nonce = ?")
            .get(nonce);
        return row !== undefined;
    }
    async add(nonce) {
        this.ensureTable();
        this.db
            .prepare("INSERT OR IGNORE INTO x402_used_nonces (nonce, used_at_ms) VALUES (?, ?)")
            .run(nonce, Date.now());
    }
    async prune(ttlMs = exports.MAX_NONCE_TTL_MS) {
        this.ensureTable();
        const cutoff = Date.now() - ttlMs;
        this.db
            .prepare("DELETE FROM x402_used_nonces WHERE used_at_ms < ?")
            .run(cutoff);
    }
}
exports.SqliteNonceStore = SqliteNonceStore;
// ─── In-memory implementation (tests only) ───────────────────────────────────
/**
 * Lightweight in-memory nonce store for unit tests.
 *
 * Does NOT survive process restarts by design.  Use this only in test
 * environments where persistence is undesirable.
 */
class InMemoryNonceStore {
    nonces = new Map();
    async has(nonce) {
        return this.nonces.has(nonce);
    }
    async add(nonce) {
        if (!this.nonces.has(nonce)) {
            this.nonces.set(nonce, Date.now());
        }
    }
    async prune(ttlMs = exports.MAX_NONCE_TTL_MS) {
        const cutoff = Date.now() - ttlMs;
        for (const [nonce, ts] of this.nonces) {
            if (ts < cutoff) {
                this.nonces.delete(nonce);
            }
        }
    }
}
exports.InMemoryNonceStore = InMemoryNonceStore;
//# sourceMappingURL=nonce_store.js.map