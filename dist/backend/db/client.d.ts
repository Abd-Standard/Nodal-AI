/**
 * backend/db/client.ts
 * DatabaseManager — thin abstraction over the local storage layer.
 * Provides a healthCheck() method consumed by the health endpoint and
 * a close() method called during graceful shutdown.
 */
export declare class DatabaseManager {
    private static instance;
    private _isOpen;
    private constructor();
    static getInstance(): DatabaseManager;
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
    healthCheck(): Promise<boolean>;
    /** Flush pending writes and release the connection. */
    close(): Promise<void>;
}
export declare const db: DatabaseManager;
//# sourceMappingURL=client.d.ts.map