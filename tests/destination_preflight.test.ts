/**
 * tests/destination_preflight.test.ts
 * Destination pre-flight checks (#788): account exists, trustline present,
 * and SEP-29 memo-required enforcement — each with its own typed error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Asset, Keypair, NotFoundError } from '@stellar/stellar-sdk';
import { assertDestinationReady } from '../backend/utils/destinationPreflight';
import { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';
import { PathPaymentTool } from '../backend/tools/PathPaymentTool';
import { KeypairSigner } from '../backend/signer';
import {
  DestinationNotFoundError,
  MemoRequiredError,
  MissingTrustlineError,
  ValidationError,
} from '../backend/errors';
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
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC = new Asset('USDC', ISSUER);
const MEMO_REQUIRED = { 'config.memo_required': Buffer.from('1').toString('base64') };

function account(
  publicKey: string,
  opts: { data?: Record<string, string>; usdc?: boolean } = {}
): Record<string, unknown> {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    balances: [
      { asset_type: 'native', balance: '100.0000000' },
      ...(opts.usdc
        ? [
            {
              asset_type: 'credit_alphanum4',
              asset_code: 'USDC',
              asset_issuer: ISSUER,
              balance: '0',
            },
          ]
        : []),
    ],
    data_attr: opts.data ?? {},
  };
}

/** Destination resolves to `dest`; any other key (the source) to a plain account. */
function mockDestination(dest: Record<string, unknown> | Error): void {
  vi.mocked(rpcClient.loadAccount).mockImplementation(async (key: string) => {
    if (key !== DEST) return account(key) as never;
    if (dest instanceof Error) throw dest;
    return dest as never;
  });
}

describe('assertDestinationReady', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes for an existing account with no special requirements', async () => {
    mockDestination(account(DEST));
    await expect(
      assertDestinationReady({ destination: DEST, asset: Asset.native(), hasMemo: false })
    ).resolves.toBeUndefined();
  });

  it('throws DestinationNotFoundError and suggests createAccount for an unfunded XLM destination', async () => {
    mockDestination(new NotFoundError('Not Found', { status: 404 }));

    const err = await assertDestinationReady({
      destination: DEST,
      asset: Asset.native(),
      hasMemo: false,
      amount: '5',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DestinationNotFoundError);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as DestinationNotFoundError).destination).toBe(DEST);
    expect((err as Error).message).toMatch(/createAccount/);
  });

  it('says when an XLM amount is below the minimum starting balance', async () => {
    mockDestination(new NotFoundError('Not Found', { status: 404 }));
    await expect(
      assertDestinationReady({
        destination: DEST,
        asset: Asset.native(),
        hasMemo: false,
        amount: '0.5',
      })
    ).rejects.toThrow(/at least 1 XLM.*0\.5 XLM is not enough/);
  });

  it('recognises a 404 wrapped by the rpc_client retry layer', async () => {
    const wrapped = Object.assign(new Error('RPC call failed after 3 attempt(s): Not Found'), {
      cause: { response: { status: 404 } },
    });
    mockDestination(wrapped);
    await expect(
      assertDestinationReady({ destination: DEST, asset: USDC, hasMemo: false })
    ).rejects.toBeInstanceOf(DestinationNotFoundError);
  });

  it('rethrows lookup failures that are not a missing account', async () => {
    mockDestination(new Error('ECONNRESET'));
    await expect(
      assertDestinationReady({ destination: DEST, asset: Asset.native(), hasMemo: false })
    ).rejects.toThrow('ECONNRESET');
  });

  it('throws MissingTrustlineError when the destination does not trust the asset', async () => {
    mockDestination(account(DEST));

    const err = await assertDestinationReady({
      destination: DEST,
      asset: USDC,
      hasMemo: false,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MissingTrustlineError);
    expect((err as MissingTrustlineError).asset).toBe(`USDC:${ISSUER}`);
  });

  it('accepts a destination with the trustline, and the issuer without one', async () => {
    mockDestination(account(DEST, { usdc: true }));
    await expect(
      assertDestinationReady({ destination: DEST, asset: USDC, hasMemo: false })
    ).resolves.toBeUndefined();

    vi.mocked(rpcClient.loadAccount).mockResolvedValue(account(ISSUER) as never);
    await expect(
      assertDestinationReady({ destination: ISSUER, asset: USDC, hasMemo: false })
    ).resolves.toBeUndefined();
  });

  it('throws MemoRequiredError when SEP-29 config.memo_required is set and no memo is given', async () => {
    mockDestination(account(DEST, { data: MEMO_REQUIRED }));
    await expect(
      assertDestinationReady({ destination: DEST, asset: Asset.native(), hasMemo: false })
    ).rejects.toBeInstanceOf(MemoRequiredError);
    await expect(
      assertDestinationReady({ destination: DEST, asset: Asset.native(), hasMemo: true })
    ).resolves.toBeUndefined();
  });
});

describe('SEP-29 enforcement in the payment tools', () => {
  const signer = new KeypairSigner(Keypair.fromSecret(TEST_SECRET));

  beforeEach(() => {
    vi.clearAllMocks();
    mockDestination(account(DEST, { data: MEMO_REQUIRED, usdc: true }));
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({ hash: 'h', ledger: 1 } as never);
  });

  it('stellar_payment refuses to sign without the required memo', async () => {
    await expect(
      new StellarPaymentTool(signer).execute({ destination: DEST, amount: '5' })
    ).rejects.toBeInstanceOf(MemoRequiredError);
    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });

  it('stellar_payment proceeds once the memo is supplied', async () => {
    await expect(
      new StellarPaymentTool(signer).execute({ destination: DEST, amount: '5', memo: '12345' })
    ).resolves.toEqual({ txHash: 'h', ledger: 1 });
  });

  it('path_payment refuses to sign without the required memo', async () => {
    await expect(
      new PathPaymentTool(signer).execute({
        destination: DEST,
        sendAsset: { code: 'XLM' },
        sendAmount: '10',
        destAsset: { code: 'USDC', issuer: ISSUER },
        destMinAmount: '9',
      })
    ).rejects.toBeInstanceOf(MemoRequiredError);
    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });
});
