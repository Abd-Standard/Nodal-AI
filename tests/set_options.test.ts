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

// Minimal stand-ins: SetOptionsTool only needs these two exports, and loading
// the real modules pulls in their full dependency graph.
vi.mock('../backend/tools/StellarPaymentTool', () => {
  const { z } = require('zod');
  return { SubmitResultSchema: z.object({ hash: z.string(), ledger: z.number() }) };
});
vi.mock('../backend/tools/SorobanInvokeTool', () => ({ SOROBAN_TX_TIMEOUT: 30 }));

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

  describe('masterWeight: 0 lockout guard', () => {
    const MASTER = Keypair.fromSecret(TEST_SECRET).publicKey();
    const OTHER = Keypair.random().publicKey();

    function accountWith(
      signers: { key: string; weight: number; type: string }[],
      highThreshold = 2
    ) {
      return {
        ...makeMockAccount(),
        thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: highThreshold },
        signers,
      };
    }

    it('rejects masterWeight 0 when no other signer exists', async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        accountWith([{ key: MASTER, weight: 1, type: 'ed25519_public_key' }]) as any
      );

      await expect(tool.execute({ masterWeight: 0 })).rejects.toThrow(
        /Refusing to set masterWeight to 0.*combined weight of 0.*confirmLockoutRisk/
      );
      expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
    });

    it('rejects masterWeight 0 when other signers are below the high threshold', async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        accountWith([{ key: OTHER, weight: 1, type: 'ed25519_public_key' }], 2) as any
      );

      await expect(tool.execute({ masterWeight: 0 })).rejects.toThrow(/combined weight of 1/);
      expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
    });

    it('does not count single-use pre-auth / hash-x signers', async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        accountWith([
          { key: 'TPREAUTH', weight: 10, type: 'preauth_tx' },
          { key: 'XHASH', weight: 10, type: 'sha256_hash' },
        ]) as any
      );

      await expect(tool.execute({ masterWeight: 0 })).rejects.toThrow(/combined weight of 0/);
    });

    it('checks against a highThreshold set in the same call', async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        accountWith([{ key: OTHER, weight: 2, type: 'ed25519_public_key' }], 2) as any
      );

      await expect(tool.execute({ masterWeight: 0, highThreshold: 5 })).rejects.toThrow(
        /below the high threshold of 5/
      );
    });

    it('allows masterWeight 0 when other signers meet the high threshold', async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        accountWith([
          { key: MASTER, weight: 1, type: 'ed25519_public_key' },
          { key: OTHER, weight: 2, type: 'ed25519_public_key' },
        ]) as any
      );

      await tool.execute({ masterWeight: 0 });

      // The check must use fresh signer data, not the account cache.
      expect(rpcClient.loadAccount).toHaveBeenCalledWith(MASTER, { forceRefresh: true });
      const op = vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0].operations[0] as any;
      expect(op.masterWeight).toBe(0);
    });

    it('allows masterWeight 0 with confirmLockoutRisk: true', async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(accountWith([]) as any);

      await tool.execute({ masterWeight: 0, confirmLockoutRisk: true });

      const op = vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0].operations[0] as any;
      expect(op.masterWeight).toBe(0);
    });
  });

  describe('AuthImmutableFlag guard', () => {
    it('rejects setFlags containing AuthImmutableFlag without confirmation', async () => {
      await expect(tool.execute({ setFlags: 4 })).rejects.toThrow(
        /Refusing to set AuthImmutableFlag.*confirmAuthImmutable/
      );
      // Also when combined with other flag bits (AuthRequired | AuthImmutable).
      await expect(tool.execute({ setFlags: 1 | 4 })).rejects.toThrow(/AuthImmutableFlag/);
      expect(rpcClient.loadAccount).not.toHaveBeenCalled();
      expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
    });

    it('allows AuthImmutableFlag with confirmAuthImmutable: true', async () => {
      await tool.execute({ setFlags: 4, confirmAuthImmutable: true });

      const op = vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0].operations[0] as any;
      expect(op.setFlags).toBe(4);
    });

    it('does not guard clearFlags', async () => {
      await tool.execute({ clearFlags: 4 });
      expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
  });
});
