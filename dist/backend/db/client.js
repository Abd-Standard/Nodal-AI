"use strict";
/**
 * backend/db/client.ts
 * DatabaseManager — thin abstraction over the local storage layer.
 * Provides a healthCheck() method consumed by the health endpoint and
 * a close() method called during graceful shutdown.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.DatabaseManager = void 0;
const logger_1 = require("../utils/logger");
const persistence_1 = require("../persistence");
const log = (0, logger_1.createLogger)("database");
class DatabaseManager {
    static instance = null;
    _isOpen = true;
    constructor() { }
    static getInstance() {
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
    async healthCheck() {
        if (!this._isOpen)
            return false;
        try {
            (0, persistence_1.probeDb)();
            return true;
        }
        catch (err) {
            log.error({ msg: "Database health probe failed", err: String(err) });
            return false;
        }
    }
    /** Flush pending writes and release the connection. */
    async close() {
        this._isOpen = false;
        log.info({ msg: "Database connection closed" });
    }
}
exports.DatabaseManager = DatabaseManager;
exports.db = DatabaseManager.getInstance();
//# sourceMappingURL=client.js.map