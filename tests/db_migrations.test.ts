/**
 * tests/db_migrations.test.ts
 *
 * Numbered SQLite migrations (#821): a fresh database is built from the
 * migration files alone, a database created before the framework existed is
 * upgraded in place without losing data, and a failing migration leaves the
 * schema untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadMigrations,
  migrateSqlite,
  sqliteSchemaVersion,
  SQLITE_MIGRATIONS_DIR,
  POSTGRES_MIGRATIONS_DIR,
} from '../backend/db/migrate';

const EXPECTED_TABLES = [
  'agent_results',
  'agent_state',
  'audit_log',
  'schema_version',
  'spending_records',
  'x402_used_nonces',
];

function tables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
}

const latestVersion = Math.max(...loadMigrations(SQLITE_MIGRATIONS_DIR).map((m) => m.version));

describe('migration files', () => {
  it('numbers SQLite and Postgres migrations identically', () => {
    const sqlite = loadMigrations(SQLITE_MIGRATIONS_DIR).map((m) => m.version);
    const postgres = loadMigrations(POSTGRES_MIGRATIONS_DIR).map((m) => m.version);
    expect(postgres).toEqual(sqlite);
  });
});

describe('fresh database', () => {
  it('is created from the migrations only', () => {
    const db = new Database(':memory:');

    const applied = migrateSqlite(db);

    expect(applied.map((m) => m.version)).toEqual(
      loadMigrations(SQLITE_MIGRATIONS_DIR).map((m) => m.version)
    );
    expect(tables(db)).toEqual(EXPECTED_TABLES);
    expect(columns(db, 'agent_results')).toContain('correlationId');
    expect(sqliteSchemaVersion(db)).toBe(latestVersion);
  });

  it('applies nothing on a second run', () => {
    const db = new Database(':memory:');
    migrateSqlite(db);

    expect(migrateSqlite(db)).toEqual([]);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM schema_version`).get() as { n: number }).n
    ).toBe(loadMigrations(SQLITE_MIGRATIONS_DIR).length);
  });

  it('creates the audit log append-only', () => {
    const db = new Database(':memory:');
    migrateSqlite(db);
    db.prepare(
      `INSERT INTO audit_log (ts, taskType, txHash, prevHash, hash)
       VALUES ('t', 'x', 'h', 'p', 'h')`
    ).run();

    expect(() => db.prepare(`DELETE FROM audit_log`).run()).toThrow(/append-only/);
  });
});

describe('existing database (created before migrations)', () => {
  /** The schema persistence.ts created ad hoc before #230 added correlationId. */
  function legacyDb(withCorrelationId: boolean): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE agent_results (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT    NOT NULL,
        taskType  TEXT    NOT NULL,
        success   INTEGER NOT NULL,
        data      TEXT,
        error     TEXT
        ${withCorrelationId ? ', correlationId TEXT' : ''}
      );
      CREATE TABLE spending_records (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        amount    REAL    NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE TABLE agent_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE x402_used_nonces (nonce TEXT PRIMARY KEY, used_at_ms INTEGER NOT NULL);
    `);
    db.prepare(
      `INSERT INTO agent_results (timestamp, taskType, success, data) VALUES (?, ?, 1, ?)`
    ).run('2026-01-01T00:00:00.000Z', 'stellar_payment', '{"txHash":"abc"}');
    db.prepare(`INSERT INTO spending_records (amount, timestamp) VALUES (?, ?)`).run(12.5, 1000);
    db.prepare(`INSERT INTO agent_state (key, value) VALUES ('paused', 'true')`).run();
    db.prepare(`INSERT INTO x402_used_nonces (nonce, used_at_ms) VALUES ('n-1', 1000)`).run();
    return db;
  }

  it.each([
    ['without correlationId', false],
    ['with correlationId', true],
  ])('is upgraded in place (%s) and keeps its data', (_label, withCorrelationId) => {
    const db = legacyDb(withCorrelationId);

    migrateSqlite(db);

    expect(tables(db)).toEqual(EXPECTED_TABLES);
    expect(columns(db, 'agent_results')).toContain('correlationId');
    expect(sqliteSchemaVersion(db)).toBe(latestVersion);

    const result = db.prepare(`SELECT taskType, data, correlationId FROM agent_results`).get();
    expect(result).toEqual({
      taskType: 'stellar_payment',
      data: '{"txHash":"abc"}',
      correlationId: null,
    });
    expect(db.prepare(`SELECT amount, timestamp FROM spending_records`).get()).toEqual({
      amount: 12.5,
      timestamp: 1000,
    });
    expect(db.prepare(`SELECT value FROM agent_state WHERE key = 'paused'`).get()).toEqual({
      value: 'true',
    });
    expect(db.prepare(`SELECT nonce FROM x402_used_nonces`).get()).toEqual({ nonce: 'n-1' });
  });
});

describe('migration runner', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nodal-migrations-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies files in version order and ignores non-migration files', () => {
    writeFileSync(join(dir, '002_add_b.sql'), `ALTER TABLE t ADD COLUMN b TEXT;`);
    writeFileSync(join(dir, '001_create_t.sql'), `CREATE TABLE t (a TEXT);`);
    writeFileSync(join(dir, 'README.md'), `not a migration`);
    const db = new Database(':memory:');

    const applied = migrateSqlite(db, dir);

    expect(applied.map((m) => m.name)).toEqual(['001_create_t.sql', '002_add_b.sql']);
    expect(columns(db, 't')).toEqual(['a', 'b']);
  });

  it('applies only the migrations added since the last run', () => {
    writeFileSync(join(dir, '001_create_t.sql'), `CREATE TABLE t (a TEXT);`);
    const db = new Database(':memory:');
    migrateSqlite(db, dir);

    writeFileSync(join(dir, '002_add_b.sql'), `ALTER TABLE t ADD COLUMN b TEXT;`);
    const applied = migrateSqlite(db, dir);

    expect(applied.map((m) => m.version)).toEqual([2]);
    expect(sqliteSchemaVersion(db)).toBe(2);
  });

  it('rolls back every change when a migration fails', () => {
    writeFileSync(join(dir, '001_create_t.sql'), `CREATE TABLE t (a TEXT);`);
    writeFileSync(join(dir, '002_broken.sql'), `ALTER TABLE missing ADD COLUMN b TEXT;`);
    const db = new Database(':memory:');

    expect(() => migrateSqlite(db, dir)).toThrow();

    expect(tables(db)).not.toContain('t');
    expect(sqliteSchemaVersion(db)).toBe(0);
  });

  it('rejects two migrations with the same version', () => {
    writeFileSync(join(dir, '001_a.sql'), `SELECT 1;`);
    writeFileSync(join(dir, '001_b.sql'), `SELECT 1;`);

    expect(() => loadMigrations(dir)).toThrow(/Duplicate migration version 1/);
  });
});
