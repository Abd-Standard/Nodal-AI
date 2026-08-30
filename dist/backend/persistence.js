"use strict";
/**
 * backend/persistence.ts
 *
 * SQLite-backed audit log for every AgentResult produced by PayFiAgent.run().
 * The DB path is configured via DB_PATH (default: ./agent.db).
 * Pass ":memory:" for in-process testing via _setDb().
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeDb = probeDb;
exports.saveResult = saveResult;
exports.getResults = getResults;
exports._setDb = _setDb;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
let _db = null;
function getDb() {
    if (!_db) {
        // Lazy import of config so that tests can inject via _setDb() before any DB access
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { config } = require("./config");
        _db = new better_sqlite3_1.default(config.DB_PATH);
        _db.exec(`
      CREATE TABLE IF NOT EXISTS agent_results (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT    NOT NULL,
        taskType      TEXT    NOT NULL,
        success       INTEGER NOT NULL,
        data          TEXT,
        error         TEXT,
        correlationId TEXT
      )
    `);
        // Idempotent migration for databases created before correlationId existed.
        const cols = _db.prepare(`PRAGMA table_info(agent_results)`).all();
        if (!cols.some((c) => c.name === "correlationId")) {
            _db.exec(`ALTER TABLE agent_results ADD COLUMN correlationId TEXT`);
        }
    }
    return _db;
}
/**
 * Execute a trivial query against the live connection (#234).
 *
 * `getDb()` owns the only `better-sqlite3` handle, so the probe belongs here
 * rather than in DatabaseManager — duplicating connection ownership to satisfy
 * a health check would mean the check exercised a handle the app does not use.
 *
 * Throws if the file is missing, corrupt, or the connection is in a bad state,
 * which is exactly what an in-memory boolean cannot detect.
 */
function probeDb() {
    getDb().prepare("SELECT 1").get();
}
function saveResult(result) {
    getDb()
        .prepare(`INSERT INTO agent_results (timestamp, taskType, success, data, error, correlationId)
       VALUES (@timestamp, @taskType, @success, @data, @error, @correlationId)`)
        .run({
        timestamp: result.timestamp,
        taskType: result.taskType,
        success: result.success ? 1 : 0,
        data: result.data !== undefined ? JSON.stringify(result.data) : null,
        error: result.error ?? null,
        correlationId: result.correlationId ?? null,
    });
}
function getResults(limit = 100, offset = 0) {
    const rows = getDb()
        .prepare(`SELECT timestamp, taskType, success, data, error, correlationId
       FROM agent_results ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(limit, offset);
    return rows.map((r) => {
        const result = {
            timestamp: r.timestamp,
            taskType: r.taskType,
            success: r.success === 1,
            data: r.data !== null ? JSON.parse(r.data) : undefined,
        };
        if (r.error !== null)
            result.error = r.error;
        if (r.correlationId !== null)
            result.correlationId = r.correlationId;
        return result;
    });
}
/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
function _setDb(db) {
    _db = db;
}
//# sourceMappingURL=persistence.js.map