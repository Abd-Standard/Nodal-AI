/**
 * tests/account_history.test.ts
 * Tests for AccountHistoryTool paginated payment history queries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { AccountHistoryTool } from '../backend/tools/AccountHistoryTool';

const { mockPaymentsCall, paymentsQuery, mockForAccount } = vi.hoisted(() => {
  const call = vi.fn();
  const query = {
    order: vi.fn(),
    limit: vi.fn(),
    cursor: vi.fn(),
    call,
  };
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  query.cursor.mockReturnValue(query);
  return {
    mockPaymentsCall: call,
    paymentsQuery: query,
    mockForAccount: vi.fn(() => query),
  };
});

vi.mock('../backend/rpc_client', () => ({
  horizonServer: {
    payments: () => ({
      forAccount: mockForAccount,
    }),
  },
}));

vi.mock('../backend/config', () => {
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
    },
  };
});

const AGENT_PUBLIC_KEY = Keypair.fromSecret(
  'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X'
).publicKey();

function makePaymentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: '123',
    type: 'payment',
    from: AGENT_PUBLIC_KEY,
    to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    amount: '10.0000000',
    asset_type: 'native',
    created_at: '2026-01-01T00:00:00Z',
    paging_token: 'token-123',
    ...overrides,
  };
}

describe('AccountHistoryTool', () => {
  let tool: AccountHistoryTool;

  beforeEach(() => {
    vi.clearAllMocks();
    paymentsQuery.order.mockReturnValue(paymentsQuery);
    paymentsQuery.limit.mockReturnValue(paymentsQuery);
    paymentsQuery.cursor.mockReturnValue(paymentsQuery);
    tool = new AccountHistoryTool();
    mockPaymentsCall.mockResolvedValue({
      records: [makePaymentRecord()],
    });
  });

  it('returns paginated payment records for the agent account by default', async () => {
    const result = await tool.fetch({ limit: 1 });

    expect(mockForAccount).toHaveBeenCalledWith(AGENT_PUBLIC_KEY);
    expect(paymentsQuery.order).toHaveBeenCalledWith('desc');
    expect(paymentsQuery.limit).toHaveBeenCalledWith(1);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      type: 'payment',
      amount: '10.0000000',
      asset: 'XLM',
    });
    expect(result.nextCursor).toBe('token-123');
  });

  it('passes cursor and publicKey when provided', async () => {
    const customKey = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

    await tool.fetch({
      publicKey: customKey,
      cursor: 'cursor-abc',
      limit: 5,
    });

    expect(mockForAccount).toHaveBeenCalledWith(customKey);
    expect(paymentsQuery.cursor).toHaveBeenCalledWith('cursor-abc');
    expect(paymentsQuery.limit).toHaveBeenCalledWith(5);
  });

  it('filters records by assetCode when provided', async () => {
    mockPaymentsCall.mockResolvedValueOnce({
      records: [
        makePaymentRecord({ asset_type: 'native' }),
        makePaymentRecord({
          id: '456',
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          paging_token: 'token-456',
        }),
      ],
    });

    const result = await tool.fetch({ assetCode: 'USDC', limit: 10 });

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.asset).toBe(
      'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
    );
  });

  it('returns null nextCursor when fewer records than limit are returned', async () => {
    mockPaymentsCall.mockResolvedValueOnce({
      records: [makePaymentRecord()],
    });

    const result = await tool.fetch({ limit: 10 });

    expect(result.nextCursor).toBeNull();
  });
});
