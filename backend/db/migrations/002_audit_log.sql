-- 002_audit_log.sql (SQLite)
--
-- Tamper-evident audit log (#744). Each row's `hash` covers the previous
-- row's hash, so editing or removing any row breaks every hash after it.
-- The triggers make the table append-only through normal SQL; the hash
-- chain catches anyone who bypasses them with direct file access.

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT    NOT NULL,
  correlationId TEXT,
  taskType      TEXT    NOT NULL,
  txHash        TEXT    NOT NULL,
  envelopeHash  TEXT,
  destination   TEXT,
  asset         TEXT,
  amount        TEXT,
  prevHash      TEXT    NOT NULL,
  hash          TEXT    NOT NULL
);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
  BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
  BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
