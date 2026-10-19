/**
 * backend/db/migrate.ts
 *
 * Numbered schema migrations (#821).
 *
 * Every schema change lives in `backend/db/migrations/NNN_<name>.sql` (SQLite)
 * or `backend/db/migrations/postgres/NNN_<name>.sql` (Postgres). On startup the
 * pending files are applied in order, each inside a transaction, and recorded
 * in a `schema_version` table so they never run twice. Adding a column is a new
 * file — never an edit to an applied one, and never an ad-hoc `ALTER TABLE` in
 * application code.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Directory holding the SQLite migrations. */
export const SQLITE_MIGRATIONS_DIR = join(__dirname, 'migrations');

/** Directory holding the Postgres migrations. */
export const POSTGRES_MIGRATIONS_DIR = join(__dirname, 'migrations', 'postgres');

const MIGRATION_FILE = /^(\d{3})_[A-Za-z0-9_-]+\.sql$/;

const CREATE_SCHEMA_VERSION = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at TEXT    NOT NULL
  )
`;

/**
 * Read every `NNN_*.sql` file in `dir`, ordered by version.
 *
 * @throws if two files share a version number, so a bad merge cannot silently
 *   skip one of them.
 */
export function loadMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir)) {
    const match = MIGRATION_FILE.exec(file);
    if (!match) continue;
    migrations.push({
      version: Number(match[1]),
      name: file,
      sql: readFileSync(join(dir, file), 'utf8'),
    });
  }
  migrations.sort((a, b) => a.version - b.version);
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i]!.version === migrations[i - 1]!.version) {
      throw new Error(
        `Duplicate migration version ${migrations[i]!.version}: ` +
          `${migrations[i - 1]!.name} and ${migrations[i]!.name}`
      );
    }
  }
  return migrations;
}

// ─── SQLite ───────────────────────────────────────────────────────────────────

/**
 * Bring a database created before the migrations framework up to the shape
 * `001_initial_schema.sql` expects. Only runs while `schema_version` is empty.
 *
 * The one ad-hoc migration that predates the framework (#230) added
 * `agent_results.correlationId`; an older file that never got it would keep
 * the column missing because 001 uses CREATE TABLE IF NOT EXISTS.
 */
function baselineLegacySqlite(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(agent_results)`).all() as Array<{ name: string }>;
  if (cols.length > 0 && !cols.some((c) => c.name === 'correlationId')) {
    db.exec(`ALTER TABLE agent_results ADD COLUMN correlationId TEXT`);
  }
}

/**
 * Apply every pending SQLite migration.
 *
 * Runs as one IMMEDIATE transaction, so two connections opening the same file
 * at startup cannot both apply a migration, and a failing migration leaves the
 * schema exactly as it was.
 *
 * @returns the migrations that were applied (empty when already up to date).
 */
export function migrateSqlite(
  db: Database.Database,
  dir: string = SQLITE_MIGRATIONS_DIR
): Migration[] {
  const migrations = loadMigrations(dir);

  const run = db.transaction((): Migration[] => {
    db.exec(CREATE_SCHEMA_VERSION);
    const applied = new Set(
      (db.prepare(`SELECT version FROM schema_version`).all() as Array<{ version: number }>).map(
        (r) => r.version
      )
    );
    if (applied.size === 0) baselineLegacySqlite(db);

    const record = db.prepare(
      `INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)`
    );
    const pending = migrations.filter((m) => !applied.has(m.version));
    for (const m of pending) {
      db.exec(m.sql);
      record.run(m.version, m.name, new Date().toISOString());
    }
    return pending;
  });

  return run.immediate();
}

/** Highest applied migration version, or 0 for an unmigrated database. */
export function sqliteSchemaVersion(db: Database.Database): number {
  const exists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)
    .get();
  if (!exists) return 0;
  const row = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

// ─── Postgres ─────────────────────────────────────────────────────────────────

/** The subset of `pg.PoolClient` the migrator needs. */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/**
 * Advisory-lock key held while migrating, so instances starting together
 * apply each migration exactly once. Arbitrary but fixed.
 */
const PG_MIGRATION_LOCK_KEY = 8_210_821;

/**
 * Apply every pending Postgres migration on `client`.
 *
 * A session-level advisory lock serialises concurrent instances; each
 * migration then runs in its own transaction together with its
 * `schema_version` row.
 *
 * @returns the migrations that were applied (empty when already up to date).
 */
export async function migratePostgres(
  client: PgQueryable,
  dir: string = POSTGRES_MIGRATIONS_DIR
): Promise<Migration[]> {
  const migrations = loadMigrations(dir);

  await client.query(`SELECT pg_advisory_lock($1)`, [PG_MIGRATION_LOCK_KEY]);
  try {
    await client.query(CREATE_SCHEMA_VERSION);
    const { rows } = await client.query(`SELECT version FROM schema_version`);
    const applied = new Set(rows.map((r: { version: number }) => Number(r.version)));

    const pending = migrations.filter((m) => !applied.has(m.version));
    for (const m of pending) {
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          `INSERT INTO schema_version (version, name, applied_at) VALUES ($1, $2, $3)`,
          [m.version, m.name, new Date().toISOString()]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
    return pending;
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [PG_MIGRATION_LOCK_KEY]);
  }
}
