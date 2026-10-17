/**
 * tests/path_payment.test.ts
 * Tests for PathPaymentTool covering happy path, slippage rejection,
 * input validation, self-payment guard, and tx_bad_seq retry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { PathPaymentTool } from '../backend/tools/PathPaymentTool';
import * as rpcClient from '../backend/rpc_client';
import { ValidationError } from '../backend/errors';
import { PayFiAgent } from '../backend/agent';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {
    strictSendPaths: vi.fn(() => ({
      call: vi.fn().mockResolvedValue({
        records: [
          {
            path: [],
            destination_amount: '9',
          },
        ],
      }),
    })),
  },
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
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const VALID_DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function makeMockAccount(publicKey: string) {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: 'native', balance: '10000.0000000' }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: '',
    inflation_dest: null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PathPaymentTool', () => {
  let tool: PathPaymentTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new PathPaymentTool(TEST_SECRET);
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey) as any);
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'path_tx_hash',
      ledger: 100,
    } as any);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('executes XLM → USDC path payment and returns txHash + ledger', async () => {
    const result = await tool.execute({
      destination: VALID_DEST,
      sendAsset: { code: 'XLM' },
      sendAmount: '10',
      destAsset: { code: 'USDC', issuer: USDC_ISSUER },
      destMinAmount: '9',
    });

    expect(result.txHash).toBe('path_tx_hash');
    expect(result.ledger).toBe(100);
    expect(rpcClient.loadAccount).toHaveBeenCalledWith(tool.publicKey);
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  it('accepts an optional intermediate path asset', async () => {
    const result = await tool.execute({
      destination: VALID_DEST,
      sendAsset: { code: 'XLM' },
      sendAmount: '10',
      destAsset: { code: 'USDC', issuer: USDC_ISSUER },
      destMinAmount: '9',
      path: [{ code: 'USD', issuer: USDC_ISSUER }],
    });

    expect(result.txHash).toBe('path_tx_hash');
  });

  it('accepts a memo when provided', async () => {
    const result = await tool.execute({
      destination: VALID_DEST,
      sendAsset: { code: 'XLM' },
      sendAmount: '5',
      destAsset: { code: 'USDC', issuer: USDC_ISSUER },
      destMinAmount: '4',
      memo: 'swap-ref-123',
    });

    expect(result.txHash).toBe('path_tx_hash');
  });

  it("accepts memo type 'id' with numeric value", async () => {
    const result = await tool.execute({
      destination: VALID_DEST,
      sendAsset: { code: 'XLM' },
      sendAmount: '5',
      destAsset: { code: 'USDC', issuer: USDC_ISSUER },
      destMinAmount: '4',
      memoType: 'id',
      memo: 987654321,
    });

    expect(result.txHash).toBe('path_tx_hash');
  });

  it("accepts memo type 'hash' with 32-byte hex string", async () => {
    const result = await tool.execute({
      destination: VALID_DEST,
      sendAsset: { code: 'XLM' },
      sendAmount: '5',
      destAsset: { code: 'USDC', issuer: USDC_ISSUER },
      destMinAmount: '4',
      memoType: 'hash',
      memo: 'b'.repeat(64),
    });

    expect(result.txHash).toBe('path_tx_hash');
  });

  it("accepts memo type 'return' with 32-byte hex string", async () => {
    const result = await tool.execute({
      destination: VALID_DEST,
      sendAsset: { code: 'XLM' },
      sendAmount: '5',
      destAsset: { code: 'USDC', issuer: USDC_ISSUER },
      destMinAmount: '4',
      memoType: 'return',
      memo: 'c'.repeat(64),
    });

    expect(result.txHash).toBe('path_tx_hash');
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('rejects missing destination', async () => {
    await expect(
      tool.execute({
        sendAsset: { code: 'XLM' },
        sendAmount: '10',
        destAsset: { code: 'USDC', issuer: USDC_ISSUER },
        destMinAmount: '9',
      })
    ).rejects.toThrow();
  });

  it('rejects non-XLM sendAsset without issuer', async () => {
    await expect(
      tool.execute({
        destination: VALID_DEST,
        sendAsset: { code: 'USDC' }, // missing issuer
        sendAmount: '10',
        destAsset: { code: 'XLM' },
        destMinAmount: '9',
      })
    ).rejects.toThrow(/Asset issuer is required/);
  });

  it('rejects zero sendAmount', async () => {
    await expect(
      tool.execute({
        destination: VALID_DEST,
        sendAsset: { code: 'XLM' },
        sendAmount: '0',
        destAsset: { code: 'USDC', issuer: USDC_ISSUER },
        destMinAmount: '9',
      })
    ).rejects.toThrow(/sendAmount must be/);
  });

  it('rejects self-payment', async () => {
    await expect(
      tool.execute({
        destination: tool.publicKey,
        sendAsset: { code: 'XLM' },
        sendAmount: '10',
        destAsset: { code: 'USDC', issuer: USDC_ISSUER },
        destMinAmount: '9',
      })
    ).rejects.toThrow("Payment destination cannot be the agent's own address");
  });

  // ── Slippage / network errors ────────────────────────────────────────────────

  it('propagates op_under_dest_min (slippage rejection) from Horizon', async () => {
    vi.mocked(rpcClient.submitTransaction).mockRejectedValue(
      new Error('Horizon: op_under_dest_min — destination minimum not met')
    );

    await expect(
      tool.execute({
        destination: VALID_DEST,
        sendAsset: { code: 'XLM' },
        sendAmount: '1',
        destAsset: { code: 'USDC', issuer: USDC_ISSUER },
        destMinAmount: '999',
      })
    ).rejects.toThrow(/op_under_dest_min/);
  });

  it('recovers from tx_bad_seq on first retry', async () => {
    vi.mocked(rpcClient.submitTransaction)
      .mockRejectedValueOnce(new Error('Horizon: tx_bad_seq — sequence number is not valid'))
      .mockResolvedValueOnce({ hash: 'retry_hash', ledger: 42 } as any);

    const result = await tool.execute({
      destination: VALID_DEST,
      sendAsset: { code: 'XLM' },
      sendAmount: '10',
      destAsset: { code: 'USDC', issuer: USDC_ISSUER },
      destMinAmount: '9',
    });

    expect(result.txHash).toBe('retry_hash');
    expect(rpcClient.submitTransaction).toHaveBeenCalledTimes(2);
  });

  // ── Empty path array (#377) ──────────────────────────────────────────────────

  it('throws ValidationError when Horizon returns an empty paths array', async () => {
    vi.mocked(rpcClient.horizonServer.strictSendPaths as any).mockReturnValueOnce({
      call: vi.fn().mockResolvedValue({ records: [] }),
    });

    await expect(
      tool.execute({
        destination: VALID_DEST,
        sendAsset: { code: 'XLM' },
        sendAmount: '10',
        destAsset: { code: 'USDC', issuer: USDC_ISSUER },
        destMinAmount: '9',
      })
    ).rejects.toThrow(ValidationError);

    vi.mocked(rpcClient.horizonServer.strictSendPaths as any).mockReturnValueOnce({
      call: vi.fn().mockResolvedValue({ records: [] }),
    });

    await expect(
      tool.execute({
        destination: VALID_DEST,
        sendAsset: { code: 'XLM' },
        sendAmount: '10',
        destAsset: { code: 'USDC', issuer: USDC_ISSUER },
        destMinAmount: '9',
      })
    ).rejects.toThrow('No path found between assets');
  });

  it('ensures empty path ValidationError propagates to AgentResult.error as a string', async () => {
    vi.mocked(rpcClient.horizonServer.strictSendPaths as any).mockReturnValueOnce({
      call: vi.fn().mockResolvedValue({ records: [] }),
    });

    const agent = new PayFiAgent();
    const result = await agent.run({
      type: 'path_payment',
      payload: {
        destination: VALID_DEST,
        sendAsset: { code: 'XLM' },
        sendAmount: '10',
        destAsset: { code: 'USDC', issuer: USDC_ISSUER },
        destMinAmount: '9',
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('No path found between assets');
    expect(typeof result.error).toBe('string');
    agent.destroy();
  });
});
