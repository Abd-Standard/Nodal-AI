/**
 * backend/db/client.ts
 * DatabaseManager — thin abstraction over the configured storage backend
 * (SQLite by default, Postgres with STORAGE_BACKEND=postgres; see storage.ts).
 * Provides migrate() run at startup, a healthCheck() method consumed by the
 * health endpoint and a close() method called during graceful shutdown.
 */

import { createLogger } from '../utils/logger';
import { getStorage } from './storage';

const log = createLogger('database');

export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private _isOpen = true;

  private constructor() {}

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  /**
   * Probe storage availability by executing `SELECT 1` (#234).
   *
   * Previously this returned the in-memory `_isOpen` flag, which is only ever
   * false after `close()` has been called. A corrupted database file, a
   * revoked file handle, or a connection left in a bad state all left the flag
   * true — so the health endpoint reported the database "up" while every query
   * failed.
   *
   * The flag is still checked first: once `close()` has run, probing would
   * reopen the connection through `getDb()`'s lazy initialiser and report a
   * shutting-down process as healthy.
   */
  async healthCheck(): Promise<boolean> {
    if (!this._isOpen) return false;
    try {
      await getStorage().probe();
      return true;
    } catch (err) {
      log.error({ msg: 'Database health probe failed', err: String(err) });
      return false;
    }
  }

  /**
   * Apply pending schema migrations (#821). Called once at startup so a
   * schema change fails the boot instead of the first query that needs it.
   */
  async migrate(): Promise<void> {
    const applied = await getStorage().migrate();
    if (applied > 0) {
      log.info({ msg: 'Applied database migrations', backend: getStorage().backend, applied });
    }
  }

  /** Flush pending writes and release the connection. */
  async close(): Promise<void> {
    await getStorage().close();
    this._isOpen = false;
    log.info({ msg: 'Database connection closed' });
  }
}

export const db = DatabaseManager.getInstance();
