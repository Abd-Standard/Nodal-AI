/**
 * tests/destination.test.ts
 * Federation address resolution (#786) and muxed-account destinations (#787),
 * with a mocked federation server.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Account, Federation, Keypair, MuxedAccount, Transaction, xdr } from '@stellar/stellar-sdk';
import {
  clearFederationCache,
  FEDERATION_CACHE_TTL_MS,
  isFederationAddress,
  paymentDestinationSchema,
  resolveDestination,
} from '../backend/utils/destination';
import {
  baseAccountId,
  stellarDestinationSchema,
  stellarPublicKeySchema,
} from '../backend/utils/stellarSchemas';
import { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';
import { PathPaymentTool } from '../backend/tools/PathPaymentTool';
import { KeypairSigner } from '../backend/signer';
import { ValidationError } from '../backend/errors';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {
    strictSendPaths: vi.fn(() => ({
      call: vi.fn().mockResolvedValue({ records: [{ path: [], destination_amount: '9' }] }),
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
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      MAX_FEE_STROOPS: 100_000,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const VALID_DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const MUXED_DEST = new MuxedAccount(new Account(VALID_DEST, '0'), '42').accountId();

function makeMockAccount(publicKey: string) {
  return new Account(publicKey, '100');
}

function submittedTx(): Transaction {
  return vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0] as Transaction;
}

describe('stellar destination schemas (#787)', () => {
  it('accepts a muxed M-address as a payment destination', () => {
    expect(stellarDestinationSchema().safeParse(MUXED_DEST).success).toBe(true);
    expect(stellarDestinationSchema().safeParse(VALID_DEST).success).toBe(true);
  });

  it('rejects an M-address with a corrupted checksum', () => {
    const corrupted = MUXED_DEST.slice(0, -1) + (MUXED_DEST.endsWith('A') ? 'B' : 'A');
    expect(stellarDestinationSchema().safeParse(corrupted).success).toBe(false);
  });

  it('keeps account-only fields G-only', () => {
    expect(stellarPublicKeySchema('Asset issuer').safeParse(MUXED_DEST).success).toBe(false);
  });

  it('reduces an M-address to its base account', () => {
    expect(baseAccountId(MUXED_DEST)).toBe(VALID_DEST);
    expect(baseAccountId(VALID_DEST)).toBe(VALID_DEST);
  });
});

describe('resolveDestination (#786)', () => {
  let resolveSpy: MockInstance<typeof Federation.Server.resolve>;

  beforeEach(() => {
    clearFederationCache();
    resolveSpy = vi.spyOn(Federation.Server, 'resolve');
  });

  afterEach(() => {
    resolveSpy.mockRestore();
    vi.useRealTimers();
  });

  it('recognises federation addresses', () => {
    expect(isFederationAddress('alice*example.com')).toBe(true);
    expect(isFederationAddress('alice@mail.com*example.com')).toBe(true);
    expect(isFederationAddress('alice*localhost')).toBe(false);
    expect(isFederationAddress(VALID_DEST)).toBe(false);
  });

  it('accepts federation addresses in payment destination fields', () => {
    expect(paymentDestinationSchema().safeParse('alice*example.com').success).toBe(true);
    const bad = paymentDestinationSchema().safeParse('not-an-address');
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe(
      'Invalid Stellar public key: Destination must be a valid Stellar public key'
    );
  });

  it('returns G- and M-addresses without a lookup', async () => {
    await expect(resolveDestination(VALID_DEST)).resolves.toEqual({ accountId: VALID_DEST });
    await expect(resolveDestination(MUXED_DEST)).resolves.toEqual({ accountId: MUXED_DEST });
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('resolves a federation address and its id memo', async () => {
    resolveSpy.mockResolvedValue({ account_id: VALID_DEST, memo_type: 'id', memo: '12345' });

    const resolved = await resolveDestination('alice*example.com');

    expect(resolved.accountId).toBe(VALID_DEST);
    expect(resolved.memo?.type).toBe('id');
    expect(resolved.memo?.value).toBe('12345');
  });

  it('decodes a base64 hash memo', async () => {
    const hash = Buffer.alloc(32, 7);
    resolveSpy.mockResolvedValue({
      account_id: VALID_DEST,
      memo_type: 'hash',
      memo: hash.toString('base64'),
    });

    const resolved = await resolveDestination('bob*example.com');

    expect(resolved.memo?.type).toBe('hash');
    expect(Buffer.from(resolved.memo?.value as Buffer).equals(hash)).toBe(true);
  });

  it('caches lookups case-insensitively until the TTL expires', async () => {
    vi.useFakeTimers();
    resolveSpy.mockResolvedValue({ account_id: VALID_DEST });

    await resolveDestination('alice*example.com');
    await resolveDestination('ALICE*Example.com');
    expect(resolveSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(FEDERATION_CACHE_TTL_MS + 1);
    await resolveDestination('alice*example.com');
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it('wraps a failed lookup in a ValidationError', async () => {
    resolveSpy.mockRejectedValue(new Error('stellar.toml not found'));
    await expect(resolveDestination('ghost*example.com')).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an invalid account returned by the federation server', async () => {
    resolveSpy.mockResolvedValue({ account_id: 'GBAD' });
    await expect(resolveDestination('alice*example.com')).rejects.toThrow(
      /invalid account for alice\*example\.com/
    );
  });
});

describe('payment tools with federation and muxed destinations', () => {
  let resolveSpy: MockInstance<typeof Federation.Server.resolve>;
  const signer = new KeypairSigner(Keypair.fromSecret(TEST_SECRET));

  beforeEach(() => {
    vi.clearAllMocks();
    clearFederationCache();
    resolveSpy = vi.spyOn(Federation.Server, 'resolve');
    vi.mocked(rpcClient.loadAccount).mockImplementation(
      async () => makeMockAccount(signer.publicKey()) as never
    );
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({ hash: 'h', ledger: 1 } as never);
  });

  afterEach(() => {
    resolveSpy.mockRestore();
  });

  it('pays a federation address and attaches the federation memo', async () => {
    resolveSpy.mockResolvedValue({ account_id: VALID_DEST, memo_type: 'text', memo: 'deposit-7' });

    await new StellarPaymentTool(signer).execute({
      destination: 'alice*example.com',
      amount: '5',
    });

    const tx = submittedTx();
    const op = tx.operations[0] as { destination: string };
    expect(op.destination).toBe(VALID_DEST);
    expect(tx.memo.type).toBe('text');
    expect(tx.memo.value?.toString()).toBe('deposit-7');
  });

  it('rejects a caller memo when the federation server requires one', async () => {
    resolveSpy.mockResolvedValue({ account_id: VALID_DEST, memo_type: 'id', memo: '1' });

    await expect(
      new StellarPaymentTool(signer).execute({
        destination: 'alice*example.com',
        amount: '5',
        memo: 'mine',
      })
    ).rejects.toThrow(/requires a federation memo/);
    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });

  it('pays a muxed M-address', async () => {
    await new StellarPaymentTool(signer).execute({ destination: MUXED_DEST, amount: '5' });

    const tx = submittedTx();
    const op = tx.operations[0] as { destination: string };
    expect(op.destination).toBe(MUXED_DEST);
    const envelopeOp = tx.toEnvelope().v1().tx().operations()[0]!;
    expect(envelopeOp.body().paymentOp().destination().switch()).toBe(
      xdr.CryptoKeyType.keyTypeMuxedEd25519()
    );
  });

  it('rejects a muxed address of the agent itself as a self-payment', async () => {
    const selfMuxed = new MuxedAccount(new Account(signer.publicKey(), '0'), '9').accountId();
    await expect(
      new StellarPaymentTool(signer).execute({ destination: selfMuxed, amount: '5' })
    ).rejects.toThrow(/own address/);
  });

  it('path-pays to a muxed M-address', async () => {
    await new PathPaymentTool(signer).execute({
      destination: MUXED_DEST,
      sendAsset: { code: 'XLM' },
      sendAmount: '10',
      destAsset: { code: 'USDC', issuer: USDC_ISSUER },
      destMinAmount: '9',
    });

    const op = submittedTx().operations[0] as { destination: string };
    expect(op.destination).toBe(MUXED_DEST);
  });
});
