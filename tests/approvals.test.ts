/**
 * tests/approvals.test.ts
 *
 * Tests for the pending-approval store in backend/persistence.ts (#736),
 * using an in-memory SQLite database.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  _setDb,
  savePendingApproval,
  getPendingApproval,
  listPendingApprovals,
  decideApproval,
  expirePendingApprovals,
  getApprovalAuditLog,
} from '../backend/persistence';

const NOW = 1_700_000_000_000;

function hold(id: string, expiresAt = NOW + 60_000): void {
  savePendingApproval({
    id,
    taskType: 'stellar_payment',
    payload: { destination: 'GDEST', amount: '600' },
    amount: '600',
    correlationId: `corr-${id}`,
    createdAt: NOW,
    expiresAt,
  });
}

beforeEach(() => {
  _setDb(new Database(':memory:'));
});

describe('pending approvals (#736)', () => {
  it('persists a held task as pending_approval and lists it', () => {
    hold('a1');

    const approval = getPendingApproval('a1');
    expect(approval).toMatchObject({
      id: 'a1',
      status: 'pending_approval',
      payload: { destination: 'GDEST', amount: '600' },
      decidedAt: null,
    });
    expect(listPendingApprovals().map((a) => a.id)).toEqual(['a1']);
  });

  it('decides an approval exactly once', () => {
    hold('a1');

    expect(decideApproval('a1', 'approved', NOW)).toBe(true);
    expect(decideApproval('a1', 'approved', NOW)).toBe(false);
    expect(decideApproval('a1', 'denied', NOW)).toBe(false);

    expect(getPendingApproval('a1')?.status).toBe('approved');
    expect(listPendingApprovals()).toEqual([]);
  });

  it('cannot approve an approval past its deadline', () => {
    hold('a1', NOW - 1);

    expect(decideApproval('a1', 'approved', NOW)).toBe(false);
    expect(getPendingApproval('a1')?.status).toBe('pending_approval');
  });

  it('expires overdue approvals and leaves the rest pending', () => {
    hold('old', NOW - 1);
    hold('new', NOW + 60_000);

    expect(expirePendingApprovals(NOW)).toEqual(['old']);
    expect(getPendingApproval('old')?.status).toBe('expired');
    expect(getPendingApproval('new')?.status).toBe('pending_approval');
    expect(expirePendingApprovals(NOW)).toEqual([]);
  });

  it('records an audit log entry for each decision', () => {
    hold('a1');
    hold('a2');
    hold('a3', NOW - 1);

    decideApproval('a1', 'approved', NOW);
    decideApproval('a2', 'denied', NOW);
    expirePendingApprovals(NOW);
    // A repeated decision is a no-op and must not be logged twice.
    decideApproval('a1', 'approved', NOW);

    expect(getApprovalAuditLog()).toEqual([
      { approvalId: 'a1', decision: 'approved', ts: NOW },
      { approvalId: 'a2', decision: 'denied', ts: NOW },
      { approvalId: 'a3', decision: 'expired', ts: NOW },
    ]);
  });
});
