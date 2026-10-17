/**
 * scripts/audit_verify.ts
 *
 * Verifies the hash chain of the `audit_log` table (#744). Recomputes every
 * row's hash from the genesis hash forward and exits non-zero on the first row
 * that was modified, removed, or reordered.
 *
 * Usage:
 *   npm run audit:verify                 # uses DB_PATH, default ./agent.db
 *   npm run audit:verify -- ./agent.db   # explicit database path
 */

import Database from 'better-sqlite3';
import * as dotenv from 'dotenv';
import { verifyAuditChain } from '../backend/persistence';

dotenv.config();

const dbPath = process.argv[2] ?? process.env.DB_PATH ?? './agent.db';
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

try {
  const result = verifyAuditChain(db);
  if (result.ok) {
    process.stdout.write(`✅ audit_log intact — ${result.checked} row(s) verified (${dbPath})\n`);
  } else {
    process.stderr.write(
      `❌ audit_log chain broken at row id ${result.brokenAt}: ${result.reason} (${dbPath})\n`
    );
    process.exitCode = 1;
  }
} finally {
  db.close();
}
