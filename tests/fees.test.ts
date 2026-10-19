/**
 * tests/fees.test.ts
 * Dynamic fee estimation from fee_stats and the tx_insufficient_fee fee-bump
 * retry (#790).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Account, FeeBumpTransaction, Keypair, Transaction } from '@stellar/stellar-sdk';
import { estimateFee, isInsufficientFeeError } from '../backend/fees';
import { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';
import { KeypairSigner } from '../backend/signer';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: { feeStats: vi.fn() },
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      MAX_FEE_STROOPS: 5_000,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const VALID_DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const feeStats = vi.mocked(rpcClient.horizonServer.feeStats);

function mockFeeStats(feeCharged: { p50: string; p90: string; p99: string }, baseFee = '100') {
  feeStats.mockResolvedValue({
    last_ledger_base_fee: baseFee,
    fee_charged: feeCharged,
  } as never);
}

describe('estimateFee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFeeStats({ p50: '150', p90: '900', p99: '3000' });
  });

  it('bids p50/p90/p99 of fee_charged for low/medium/high priority', async () => {
    await expect(estimateFee({ priority: 'low' })).resolves.toBe('150');
    await expect(estimateFee({ priority: 'medium' })).resolves.toBe('900');
    await expect(estimateFee({ priority: 'high' })).resolves.toBe('3000');
  });

  it('defaults to medium priority', async () => {
    await expect(estimateFee()).resolves.toBe('900');
  });

  it('never bids below the last ledger base fee', async () => {
    mockFeeStats({ p50: '100', p90: '100', p99: '100' }, '250');
    await expect(estimateFee({ priority: 'low' })).resolves.toBe('250');
  });

  it('caps the bid at MAX_FEE_STROOPS during a surge', async () => {
    mockFeeStats({ p50: '4000', p90: '20000', p99: '90000' });
    await expect(estimateFee({ priority: 'high' })).resolves.toBe('5000');
  });

  it('falls back to BASE_FEE when fee_stats is unavailable', async () => {
    feeStats.mockRejectedValue(new Error('Horizon down'));
    await expect(estimateFee()).resolves.toBe('100');
  });
});

describe('isInsufficientFeeError', () => {
  it('detects the result code in the message, response extras, or cause', () => {
    expect(isInsufficientFeeError(new Error('tx failed: tx_insufficient_fee'))).toBe(true);
    const horizonErr = Object.assign(new Error('Transaction submission failed'), {
      response: { data: { extras: { result_codes: { transaction: 'tx_insufficient_fee' } } } },
    });
    expect(isInsufficientFeeError(horizonErr)).toBe(true);
    expect(isInsufficientFeeError(Object.assign(new Error('wrapped'), { cause: horizonErr }))).toBe(
      true
    );
    expect(isInsufficientFeeError(new Error('tx_bad_seq'))).toBe(false);
  });
});

describe('surge retry via fee bump', () => {
  const signer = new KeypairSigner(Keypair.fromSecret(TEST_SECRET));
  let tool: StellarPaymentTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new StellarPaymentTool(signer);
    vi.mocked(rpcClient.loadAccount).mockImplementation(
      async () => new Account(signer.publicKey(), '100') as never
    );
    mockFeeStats({ p50: '150', p90: '900', p99: '3000' });
  });

  it('builds the payment with the estimated fee', async () => {
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({ hash: 'h', ledger: 1 } as never);

    await tool.execute({ destination: VALID_DEST, amount: '1' });

    const tx = vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0] as Transaction;
    expect(tx.fee).toBe('900');
  });

  it('resubmits inside a fee bump at the high estimate on tx_insufficient_fee', async () => {
    vi.mocked(rpcClient.submitTransaction)
      .mockRejectedValueOnce(new Error('Transaction failed: tx_insufficient_fee'))
      .mockResolvedValueOnce({ hash: 'bumped', ledger: 2 } as never);

    const result = await tool.execute({ destination: VALID_DEST, amount: '1' });

    expect(result).toEqual({ txHash: 'bumped', ledger: 2 });
    const calls = vi.mocked(rpcClient.submitTransaction).mock.calls;
    expect(calls).toHaveLength(2);
    const inner = calls[0]![0] as Transaction;
    const bump = calls[1]![0] as FeeBumpTransaction;
    expect(bump).toBeInstanceOf(FeeBumpTransaction);
    expect(bump.feeSource).toBe(signer.publicKey());
    // (1 inner op + the bump) × p99
    expect(bump.fee).toBe('6000');
    expect(bump.innerTransaction.hash().equals(inner.hash())).toBe(true);
    expect(bump.signatures).toHaveLength(1);
  });

  it('gives up when MAX_FEE_STROOPS leaves no room to outbid the inner fee', async () => {
    mockFeeStats({ p50: '5000', p90: '5000', p99: '5000' });
    vi.mocked(rpcClient.submitTransaction).mockRejectedValue(
      new Error('Transaction failed: tx_insufficient_fee')
    );

    await expect(tool.execute({ destination: VALID_DEST, amount: '1' })).rejects.toThrow(
      /MAX_FEE_STROOPS/
    );
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });
});
