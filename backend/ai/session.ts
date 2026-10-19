/**
 * backend/ai/session.ts
 *
 * Bounded, expiring session store for multi-turn AI conversations.
 *
 * Why this exists
 * ───────────────
 * Users refer back to earlier context ("send the same amount to Bob").
 * Without a session, every turn starts cold and the planner cannot resolve
 * implicit references. But an unbounded in-memory store would leak both
 * memory and conversation history.
 *
 * Design
 * ──────
 *  • Sessions are keyed by a caller-supplied sessionId.
 *  • Each session holds a bounded message history (FIFO ring buffer) and a
 *    set of resolved entities (addresses, last amounts, etc.).
 *  • Sessions expire after SESSION_TTL_MS of inactivity (last access).
 *  • Total sessions are capped at MAX_SESSIONS; the least-recently-used
 *    session is evicted when the cap is reached.
 *  • No secrets are stored — entity values are plain strings (public addresses,
 *    numeric amounts). Secret keys must never be passed as entity values.
 *
 * Configuration (env vars with safe defaults)
 * ───────────────────────────────────────────
 *  SESSION_TTL_MS          – idle TTL in ms         (default: 30 min)
 *  SESSION_MAX_MESSAGES    – messages per session    (default: 50)
 *  SESSION_MAX_SESSIONS    – total sessions in store (default: 500)
 *
 * Usage
 * ─────
 *   import { sessionStore } from './session';
 *
 *   // Add a user message
 *   sessionStore.addMessage(sessionId, { role: 'user', content: 'Send 10 USDC to Bob' });
 *
 *   // Resolve an entity reference
 *   sessionStore.setEntity(sessionId, 'Bob', 'GBOB...ADDRESS');
 *   const addr = sessionStore.getEntity(sessionId, 'Bob');
 *
 *   // Retrieve full history for an LLM prompt
 *   const history = sessionStore.getHistory(sessionId);
 */

import { createLogger } from '../utils/logger';

const log = createLogger('session-store');

// ─── Environment helpers ──────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const SESSION_CONFIG = {
  /** Idle TTL in milliseconds before a session is evicted. */
  ttlMs: envInt('SESSION_TTL_MS', 30 * 60 * 1_000),
  /** Maximum number of messages retained per session (ring-buffer). */
  maxMessages: envInt('SESSION_MAX_MESSAGES', 50),
  /** Maximum number of concurrent sessions in the store. */
  maxSessions: envInt('SESSION_MAX_SESSIONS', 500),
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

export interface SessionMessage {
  role: MessageRole;
  content: string;
  /** Unix timestamp (ms) when the message was added. */
  timestamp: number;
}

export interface SessionSnapshot {
  sessionId: string;
  messages: SessionMessage[];
  /** Resolved entity map (e.g. { Bob: "GBOB..." }). */
  entities: Record<string, string>;
  /** Unix timestamp (ms) when the session was created. */
  createdAt: number;
  /** Unix timestamp (ms) of the last read or write. */
  lastAccessedAt: number;
  /** How many messages were dropped due to the per-session ring-buffer cap. */
  droppedMessages: number;
}

// ─── Internal session record ──────────────────────────────────────────────────

interface SessionRecord {
  messages: SessionMessage[];
  entities: Map<string, string>;
  createdAt: number;
  lastAccessedAt: number;
  droppedMessages: number;
}

// ─── Session Store ────────────────────────────────────────────────────────────

export class SessionStore {
  private readonly store = new Map<string, SessionRecord>();

  // ── Write API ──────────────────────────────────────────────────────────────

  /**
   * Append a message to the session history.
   *
   * When the ring buffer is full, the oldest message is evicted (FIFO) and
   * the drop counter is incremented for observability.
   *
   * @param sessionId - The session key (e.g. HTTP request session token).
   * @param message   - Message to append (role + content; timestamp is set here).
   */
  addMessage(sessionId: string, message: Omit<SessionMessage, 'timestamp'>): void {
    const session = this.touchOrCreate(sessionId);

    if (session.messages.length >= SESSION_CONFIG.maxMessages) {
      session.messages.shift(); // evict oldest
      session.droppedMessages += 1;
    }

    session.messages.push({ ...message, timestamp: Date.now() });
    log.debug({ sessionId, role: message.role, messageCount: session.messages.length }, 'Message added to session');
  }

  /**
   * Store or update a resolved entity for the session.
   *
   * Entities are arbitrary string→string mappings (e.g. "Bob" → "GBOB…").
   * Callers MUST NOT store secret keys as entity values.
   *
   * @param sessionId  - The session key.
   * @param entityName - Case-sensitive entity name (e.g. "Bob", "lastAmount").
   * @param value      - The resolved value (e.g. a Stellar address or amount string).
   */
  setEntity(sessionId: string, entityName: string, value: string): void {
    const session = this.touchOrCreate(sessionId);
    session.entities.set(entityName, value);
    log.debug({ sessionId, entityName }, 'Entity set on session');
  }

  // ── Read API ───────────────────────────────────────────────────────────────

  /**
   * Retrieve a resolved entity by name.
   *
   * @returns The entity value, or undefined when not found.
   */
  getEntity(sessionId: string, entityName: string): string | undefined {
    const session = this.touch(sessionId);
    return session?.entities.get(entityName);
  }

  /**
   * Return the message history for an LLM prompt.
   *
   * @returns Ordered array of messages (oldest first), or empty array when
   *   the session does not exist.
   */
  getHistory(sessionId: string): SessionMessage[] {
    const session = this.touch(sessionId);
    return session ? [...session.messages] : [];
  }

  /**
   * Return an immutable snapshot of a session for inspection/export.
   *
   * @returns SessionSnapshot, or null when the session does not exist.
   */
  getSnapshot(sessionId: string): SessionSnapshot | null {
    const session = this.touch(sessionId);
    if (!session) return null;

    return {
      sessionId,
      messages: [...session.messages],
      entities: Object.fromEntries(session.entities),
      createdAt: session.createdAt,
      lastAccessedAt: session.lastAccessedAt,
      droppedMessages: session.droppedMessages,
    };
  }

  /**
   * Check whether a session exists (without bumping lastAccessedAt).
   */
  has(sessionId: string): boolean {
    this.evictExpired();
    return this.store.has(sessionId);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Explicitly delete a session and all its data.
   */
  delete(sessionId: string): void {
    this.store.delete(sessionId);
    log.info({ sessionId }, 'Session deleted');
  }

  /**
   * Return the number of active (non-expired) sessions.
   */
  size(): number {
    this.evictExpired();
    return this.store.size;
  }

  /**
   * Force an eviction pass — useful in tests and for scheduled housekeeping.
   */
  evictExpired(): void {
    const now = Date.now();
    const cutoff = now - SESSION_CONFIG.ttlMs;
    let evicted = 0;

    for (const [id, session] of this.store) {
      if (session.lastAccessedAt < cutoff) {
        this.store.delete(id);
        evicted++;
      }
    }

    if (evicted > 0) {
      log.info({ evicted, remaining: this.store.size }, 'Expired sessions evicted');
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Return the session and update its lastAccessedAt.
   * Runs an eviction pass first to honour TTL.
   * Returns undefined when the session does not exist.
   */
  private touch(sessionId: string): SessionRecord | undefined {
    this.evictExpired();
    const session = this.store.get(sessionId);
    if (session) {
      session.lastAccessedAt = Date.now();
    }
    return session;
  }

  /**
   * Return the session (updating lastAccessedAt) or create a new one.
   *
   * When the store is full, the LRU session is evicted to make room before
   * creating the new session.
   */
  private touchOrCreate(sessionId: string): SessionRecord {
    this.evictExpired();

    const existing = this.store.get(sessionId);
    if (existing) {
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    // Enforce max-session cap — evict LRU
    if (this.store.size >= SESSION_CONFIG.maxSessions) {
      this.evictLru();
    }

    const now = Date.now();
    const newSession: SessionRecord = {
      messages: [],
      entities: new Map(),
      createdAt: now,
      lastAccessedAt: now,
      droppedMessages: 0,
    };
    this.store.set(sessionId, newSession);
    log.info({ sessionId, totalSessions: this.store.size }, 'Session created');
    return newSession;
  }

  /**
   * Evict the least-recently-used session to free a slot.
   */
  private evictLru(): void {
    let lruId: string | null = null;
    let lruTime = Infinity;

    for (const [id, session] of this.store) {
      if (session.lastAccessedAt < lruTime) {
        lruTime = session.lastAccessedAt;
        lruId = id;
      }
    }

    if (lruId !== null) {
      this.store.delete(lruId);
      log.warn({ evictedId: lruId }, 'LRU session evicted due to max-session cap');
    }
  }
}

// ─── Process-wide singleton ───────────────────────────────────────────────────

export const sessionStore = new SessionStore();
