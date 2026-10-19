-- 001_initial_schema.sql (SQLite)
--
-- Baseline schema: every table that used to be created ad hoc by
-- persistence.ts and nonce_store.ts. Written with IF NOT EXISTS so a database
-- created before the migrations framework (#821) is adopted in place instead
-- of failing on tables that already exist.

-- AgentResult audit trail.
CREATE TABLE IF NOT EXISTS agent_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp     TEXT    NOT NULL,
  taskType      TEXT    NOT NULL,
  success       INTEGER NOT NULL,
  data          TEXT,
  error         TEXT,
  correlationId TEXT
);

-- Rolling spending window (#372), kept so the tracker survives a restart.
CREATE TABLE IF NOT EXISTS spending_records (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  amount    REAL    NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spending_records_timestamp
  ON spending_records (timestamp);

-- Operator-controlled agent state (e.g. the kill switch).
CREATE TABLE IF NOT EXISTS agent_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- x402 replay protection.
CREATE TABLE IF NOT EXISTS x402_used_nonces (
  nonce      TEXT    PRIMARY KEY,
  used_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x402_nonces_used_at
  ON x402_used_nonces (used_at_ms);
