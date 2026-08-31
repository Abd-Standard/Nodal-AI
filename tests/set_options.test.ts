/**
 * tests/set_options.test.ts
 * Tests for SetOptionsTool (#391)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransactionBuilder, Operation, Keypair } from '@stellar/stellar-sdk';
import { SetOptionsTool } from '../backend/tools/SetOptionsTool';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/config', () => {
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';

function makeMockAccount() {
  const publicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
  return {
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: 'native', balance: '100.0000000' }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
  };
}

describe('SetOptionsTool', () => {
  let tool: SetOptionsTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new SetOptionsTool(TEST_SECRET);
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'set_opts_hash',
      ledger: 42,
    } as any);
  });

  it('submits setOptions with home domain and thresholds', async () => {
    const result = await tool.execute({
      homeDomain: 'example.com',
      masterWeight: 1,
      lowThreshold: 1,
      medThreshold: 2,
      highThreshold: 3,
    });

    expect(result.txHash).toBe('set_opts_hash');
    expect(result.ledger).toBe(42);
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();

    const submittedTx = vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0];
    const op = submittedTx.operations[0] as any;
    expect(op.type).toBe('setOptions');
    expect(op.homeDomain).toBe('example.com');
    expect(op.masterWeight).toBe(1);
    expect(op.lowThreshold).toBe(1);
    expect(op.medThreshold).toBe(2);
    expect(op.highThreshold).toBe(3);
  });

  it('submits setOptions with setFlags and clearFlags', async () => {
    await tool.execute({ setFlags: 1, clearFlags: 2 });

    const submittedTx = vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0];
    const op = submittedTx.operations[0] as any;
    expect(op.setFlags).toBe(1);
    expect(op.clearFlags).toBe(2);
  });

  it('propagates submission errors', async () => {
    vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error('tx_failed'));
    await expect(tool.execute({ homeDomain: 'example.com' })).rejects.toThrow('tx_failed');
  });
});
