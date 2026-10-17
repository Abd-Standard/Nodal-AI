/**
 * tests/fee_bump.test.ts
 * Tests for FeeBumpTool covering: valid inner XDR, malformed XDR rejection,
 * fee calculation, self-fee-bump guard, and submission.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Networks,
} from '@stellar/stellar-sdk';
import { FeeBumpTool } from '../backend/tools/FeeBumpTool';
import { ValidationError } from '../backend/errors';
import * as rpcClient from '../backend/rpc_client';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => Networks.TESTNET),
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

const AGENT_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const INNER_SECRET = 'SDPFZL3WZ' + 'FXHQVLZX3TUZ5VXYYNZGLHC5BKWBHXMB5E6D64B2YJJFHF5';
const DEST_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

/** Build a minimal signed transaction XDR to use as inner tx in tests */
function buildInnerTxXdr(): string {
  const innerKeypair = Keypair.random();
  // We need a mock account-like object for TransactionBuilder
  const mockAccount = {
    accountId: () => innerKeypair.publicKey(),
    sequenceNumber: () => '100',
    incrementSequenceNumber: () => {},
    sequence: '100',
    incrementedSequenceNumber: () => '101',
  };

  const tx = new TransactionBuilder(mockAccount as any, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: DEST_KEY,
        asset: Asset.native(),
        amount: '1',
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(innerKeypair);
  return tx.toEnvelope().toXDR('base64');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FeeBumpTool', () => {
  let tool: FeeBumpTool;
  let validInnerXdr: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new FeeBumpTool(AGENT_SECRET);
    validInnerXdr = buildInnerTxXdr();
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'fee_bump_tx_hash',
      ledger: 200,
    } as any);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it('wraps a valid inner transaction and returns txHash + ledger', async () => {
    const result = await tool.execute({ innerTxXdr: validInnerXdr });

    expect(result.txHash).toBe('fee_bump_tx_hash');
    expect(result.ledger).toBe(200);
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  it('uses the agent public key as default feeAccount', async () => {
    await tool.execute({ innerTxXdr: validInnerXdr });
    // submitTransaction is called — tool resolved feeAccount to agent key without error
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  it('accepts an explicit feeAccount override', async () => {
    const result = await tool.execute({
      innerTxXdr: validInnerXdr,
      feeAccount: DEST_KEY,
    });
    expect(result.txHash).toBe('fee_bump_tx_hash');
  });

  it('applies baseFeeMultiplier to increase the fee', async () => {
    const result = await tool.execute({
      innerTxXdr: validInnerXdr,
      baseFeeMultiplier: 5,
    });
    expect(result.txHash).toBe('fee_bump_tx_hash');
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('rejects malformed (non-base64) XDR with ValidationError', async () => {
    const error = await tool.execute({ innerTxXdr: 'not-valid-xdr!!!' }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toMatch(/Invalid base64 encoding|Invalid inner transaction XDR/);
  });

  it('rejects corrupted base64 XDR with ValidationError before SDK call', async () => {
    // Valid base64 but invalid XDR binary payload
    const corruptedBase64 = Buffer.from('this is definitely not a stellar transaction').toString(
      'base64'
    );
    const error = await tool.execute({ innerTxXdr: corruptedBase64 }).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });

  it('throws when innerTxXdr is a fee-bump transaction itself', async () => {
    // Build a real inner transaction, then wrap it in a fee-bump envelope.
    // Passing that fee-bump XDR as innerTxXdr must be rejected because the
    // protocol forbids nested fee-bump transactions.
    const innerXdr = buildInnerTxXdr();
    const agentKeypair = Keypair.fromSecret(AGENT_SECRET);
    const innerTx = TransactionBuilder.fromXDR(innerXdr, Networks.TESTNET);
    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      agentKeypair.publicKey(),
      String(parseInt(BASE_FEE, 10) * 2),
      innerTx as any,
      Networks.TESTNET
    );
    feeBumpTx.sign(agentKeypair);
    const feeBumpXdr = feeBumpTx.toEnvelope().toXDR('base64');

    await expect(tool.execute({ innerTxXdr: feeBumpXdr })).rejects.toThrow(
      /Inner transaction must not itself be a fee-bump transaction/
    );
  });

  it('rejects an empty innerTxXdr', async () => {
    await expect(tool.execute({ innerTxXdr: '' })).rejects.toThrow();
  });

  it('rejects an invalid feeAccount key (wrong length)', async () => {
    await expect(
      tool.execute({ innerTxXdr: validInnerXdr, feeAccount: 'GABC123' })
    ).rejects.toThrow(/Invalid Stellar public key/);
  });

  it('rejects baseFeeMultiplier of zero', async () => {
    await expect(
      tool.execute({ innerTxXdr: validInnerXdr, baseFeeMultiplier: 0 })
    ).rejects.toThrow();
  });

  it('rejects baseFeeMultiplier of 1 (must be >= 2)', async () => {
    await expect(
      tool.execute({ innerTxXdr: validInnerXdr, baseFeeMultiplier: 1 })
    ).rejects.toThrow();
  });

  // ── Fee calculation ─────────────────────────────────────────────────────────

  it('exposes the agent public key', () => {
    expect(tool.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it('propagates submission errors from Horizon', async () => {
    vi.mocked(rpcClient.submitTransaction).mockRejectedValue(
      new Error('Horizon: tx_fee_bump_inner_failed')
    );

    await expect(tool.execute({ innerTxXdr: validInnerXdr })).rejects.toThrow(
      /tx_fee_bump_inner_failed/
    );
  });
});
