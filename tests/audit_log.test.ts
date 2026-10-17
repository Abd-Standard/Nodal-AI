/**
 * tests/audit_log.test.ts
 *
 * Tests for the append-only, hash-chained audit log (#744) using an in-memory
 * SQLite database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  _setDb,
  appendAuditEntry,
  computeAuditHash,
  getAuditLog,
  verifyAuditChain,
  AUDIT_GENESIS_HASH,
  type AuditEntry,
} from '../backend/persistence';

const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-10-16T12:00:00.000Z',
    correlationId: 'corr-1',
    taskType: 'stellar_payment',
    txHash: 'a'.repeat(64),
    envelopeHash: null,
    destination: DEST,
    asset: 'XLM',
    amount: '10',
    ...overrides,
  };
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  _setDb(db);
});

describe('audit log — append', () => {
  it('chains the first row to the genesis hash', () => {
    const row = appendAuditEntry(makeEntry());

    expect(row.id).toBe(1);
    expect(row.prevHash).toBe(AUDIT_GENESIS_HASH);
    expect(row.hash).toBe(computeAuditHash(AUDIT_GENESIS_HASH, makeEntry()));
  });

  it('chains each row to the previous row hash', () => {
    const first = appendAuditEntry(makeEntry());
    const second = appendAuditEntry(makeEntry({ txHash: 'b'.repeat(64), amount: '20' }));

    expect(second.prevHash).toBe(first.hash);
    expect(getAuditLog()).toHaveLength(2);
  });

  it('produces a different hash when any field changes', () => {
    const base = computeAuditHash(AUDIT_GENESIS_HASH, makeEntry());

    expect(computeAuditHash(AUDIT_GENESIS_HASH, makeEntry({ amount: '10.1' }))).not.toBe(base);
    expect(computeAuditHash(AUDIT_GENESIS_HASH, makeEntry({ destination: null }))).not.toBe(base);
    expect(computeAuditHash('f'.repeat(64), makeEntry())).not.toBe(base);
  });
});

describe('audit log — append-only enforcement', () => {
  it('rejects UPDATE through normal SQL', () => {
    appendAuditEntry(makeEntry());

    expect(() => db.prepare(`UPDATE audit_log SET amount = '9999' WHERE id = 1`).run()).toThrow(
      /append-only/
    );
  });

  it('rejects DELETE through normal SQL', () => {
    appendAuditEntry(makeEntry());

    expect(() => db.prepare(`DELETE FROM audit_log WHERE id = 1`).run()).toThrow(/append-only/);
  });
});

describe('audit log — verification', () => {
  beforeEach(() => {
    appendAuditEntry(makeEntry());
    appendAuditEntry(makeEntry({ txHash: 'b'.repeat(64), amount: '20' }));
    appendAuditEntry(makeEntry({ txHash: 'c'.repeat(64), amount: '30' }));
  });

  it('verifies an untouched chain', () => {
    expect(verifyAuditChain()).toEqual({ ok: true, checked: 3 });
  });

  it('verifies an empty log', () => {
    _setDb(new Database(':memory:'));

    expect(verifyAuditChain()).toEqual({ ok: true, checked: 0 });
  });

  it('detects a modified row', () => {
    // Simulate tampering with direct file access, which bypasses the triggers.
    db.exec(`DROP TRIGGER audit_log_no_update`);
    db.prepare(`UPDATE audit_log SET amount = '2000' WHERE id = 2`).run();

    const result = verifyAuditChain();

    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.reason).toMatch(/modified/);
  });

  it('detects a modified row whose hash was recomputed in place', () => {
    db.exec(`DROP TRIGGER audit_log_no_update`);
    const row = getAuditLog()[1]!;
    const forged = { ...row, amount: '2000' };
    db.prepare(`UPDATE audit_log SET amount = ?, hash = ? WHERE id = 2`).run(
      forged.amount,
      computeAuditHash(row.prevHash, forged)
    );

    const result = verifyAuditChain();

    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
  });

  it('detects a removed row', () => {
    db.exec(`DROP TRIGGER audit_log_no_delete`);
    db.prepare(`DELETE FROM audit_log WHERE id = 2`).run();

    const result = verifyAuditChain();

    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(3);
    expect(result.reason).toMatch(/removed or reordered/);
  });

  it('verifies a database handle passed explicitly', () => {
    const other = new Database(':memory:');
    _setDb(other);
    appendAuditEntry(makeEntry());
    _setDb(db);

    expect(verifyAuditChain(other)).toEqual({ ok: true, checked: 1 });
  });
});
