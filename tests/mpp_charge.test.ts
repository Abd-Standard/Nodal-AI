/**
 * tests/mpp_charge.test.ts
 * MPP Charge client (#777) against a local MPP server, with Soroban RPC mocked.
 * The testnet round trip lives in tests/e2e/mpp_charge_roundtrip.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToBigInt,
  xdr,
} from '@stellar/stellar-sdk';
import { MppChargeClient, parsePaymentChallenges } from '../backend/payments/mpp';
import { KeypairSigner } from '../backend/signer';
import { PolicyViolationError, ValidationError } from '../backend/errors';
import * as rpcClient from '../backend/rpc_client';
import { spendingTracker } from '../backend/spending_tracker';
import { _resetKillSwitch, pauseAgent } from '../backend/kill_switch';

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  prepareSorobanTx: vi.fn(),
  simulateSorobanTx: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/spending_tracker', () => ({
  spendingTracker: { reserve: vi.fn(() => 'res-1'), commit: vi.fn(), release: vi.fn() },
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    MAINNET_SPENDING_CAP: 10_000,
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      AGENT_SPENDING_LIMIT: '10',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const payerKp = Keypair.fromSecret(TEST_SECRET);
const RECIPIENT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const OTHER_SAC = new Asset(
  'USDC',
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
).contractId(Networks.TESTNET);
const TX_HASH = 'a'.repeat(64);

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Stand-in for simulation: attach a source-account auth entry for whatever
 * `transfer` the transaction invokes — or, with `override`, for a different one.
 */
function mockPrepare(override?: { contract?: string; amount?: bigint }): void {
  vi.mocked(rpcClient.prepareSorobanTx).mockImplementation(async (tx: Transaction) => {
    const func = tx
      .toEnvelope()
      .v1()
      .tx()
      .operations()[0]!
      .body()
      .invokeHostFunctionOp()
      .hostFunction();
    const call = func.invokeContract();
    const args = call.args();
    const authArgs = override?.amount
      ? [args[0]!, args[1]!, nativeToScVal(override.amount, { type: 'i128' })]
      : args;
    const auth = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: override?.contract
              ? new Address(override.contract).toScAddress()
              : call.contractAddress(),
            functionName: 'transfer',
            args: authArgs,
          })
        ),
        subInvocations: [],
      }),
    });
    return TransactionBuilder.cloneFrom(tx)
      .clearOperations()
      .addOperation(Operation.invokeHostFunction({ func, auth: [auth] }))
      .build();
  });
}

interface ServerState {
  credentials: Array<{
    challenge: Record<string, unknown>;
    payload: Record<string, unknown>;
    source: string;
  }>;
  resourceHits: number;
}

/** Minimal MPP Charge server: 402 challenge, then 200 + receipt for a matching credential. */
async function startServer(
  request: Record<string, unknown>,
  extra: Record<string, string> = {}
): Promise<{ url: string; state: ServerState; close: () => Promise<void> }> {
  const state: ServerState = { credentials: [], resourceHits: 0 };
  const params = {
    id: 'challenge-1',
    realm: 'api.test',
    method: 'stellar',
    intent: 'charge',
    request: b64url(request),
    ...extra,
  };
  const challengeHeader =
    'Bearer realm="other", Payment ' +
    Object.entries(params)
      .map(([k, v]) => `${k}="${v}"`)
      .join(', ');

  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Payment ')) {
      res.writeHead(402, { 'WWW-Authenticate': challengeHeader });
      res.end();
      return;
    }
    const credential = JSON.parse(Buffer.from(auth.slice(8), 'base64url').toString('utf8'));
    state.credentials.push(credential);
    if (credential.challenge.id !== params.id || credential.challenge.request !== params.request) {
      res.writeHead(402, { 'WWW-Authenticate': challengeHeader });
      res.end();
      return;
    }
    state.resourceHits++;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Payment-Receipt': b64url({
        method: 'stellar',
        reference: TX_HASH,
        status: 'success',
        timestamp: new Date().toISOString(),
      }),
    });
    res.end(JSON.stringify({ data: 'paid content' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/data`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const chargeRequest = {
  amount: '1000000', // 0.1 in 7-decimal base units
  currency: XLM_SAC,
  recipient: RECIPIENT,
  methodDetails: { network: 'stellar:testnet', credentialTypes: ['transaction', 'signedHash'] },
};

describe('parsePaymentChallenges', () => {
  it('extracts Payment challenges and skips other schemes', () => {
    const parsed = parsePaymentChallenges(
      'Bearer realm="x", Payment id="a", method="stellar", intent="charge", description="say \\"hi\\"", Payment id="b"'
    );
    expect(parsed).toEqual([
      { id: 'a', method: 'stellar', intent: 'charge', description: 'say "hi"' },
      { id: 'b' },
    ]);
  });
});

describe('MppChargeClient', () => {
  let client: MppChargeClient;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetKillSwitch();
    client = new MppChargeClient(new KeypairSigner(payerKp));
    vi.mocked(rpcClient.loadAccount).mockImplementation(
      async (key: string) => new Account(key, '100') as never
    );
    mockPrepare();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('pays a 402 challenge with a signed SAC transfer and returns the paid response', async () => {
    server = await startServer(chargeRequest);

    const { response, payment } = await client.fetch(server.url);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: 'paid content' });
    expect(payment).toEqual({
      protocol: 'mpp-charge',
      network: 'stellar:testnet',
      challengeId: 'challenge-1',
      payer: payerKp.publicKey(),
      recipient: RECIPIENT,
      currency: XLM_SAC,
      amount: '0.1000000',
      reference: TX_HASH,
    });

    // The credential echoes the challenge and carries a signed transfer of exactly the request.
    const [credential] = server.state.credentials;
    expect(credential!.source).toBe(`did:pkh:stellar:testnet:${payerKp.publicKey()}`);
    expect(credential!.payload.type).toBe('transaction');
    const tx = new Transaction(credential!.payload.transaction as string, Networks.TESTNET);
    expect(tx.source).toBe(payerKp.publicKey());
    expect(payerKp.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
    const call = tx
      .toEnvelope()
      .v1()
      .tx()
      .operations()[0]!
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract();
    expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(XLM_SAC);
    expect(call.functionName().toString()).toBe('transfer');
    expect(Address.fromScVal(call.args()[1]!).toString()).toBe(RECIPIENT);
    expect(scValToBigInt(call.args()[2]!)).toBe(1_000_000n);

    // Spending policy: reserved in the rolling window and committed once sent.
    expect(spendingTracker.reserve).toHaveBeenCalledWith('0.1000000');
    expect(spendingTracker.commit).toHaveBeenCalledWith('res-1');
    expect(spendingTracker.release).not.toHaveBeenCalled();
  });

  it('returns a non-402 response unpaid', async () => {
    const plain = http.createServer((_req, res) => res.end('free'));
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', () => resolve()));
    try {
      const { response, payment } = await client.fetch(
        `http://127.0.0.1:${(plain.address() as AddressInfo).port}/`
      );
      expect(await response.text()).toBe('free');
      expect(payment).toBeUndefined();
      expect(spendingTracker.reserve).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    }
  });

  it('refuses a charge above AGENT_SPENDING_LIMIT before signing', async () => {
    server = await startServer({ ...chargeRequest, amount: '200000000' }); // 20 > limit of 10
    await expect(client.fetch(server.url)).rejects.toBeInstanceOf(PolicyViolationError);
    expect(rpcClient.prepareSorobanTx).not.toHaveBeenCalled();
    expect(server.state.credentials).toHaveLength(0);
  });

  it('refuses to pay while the kill switch is engaged', async () => {
    server = await startServer(chargeRequest);
    pauseAgent('test');
    await expect(client.fetch(server.url)).rejects.toThrow(/paused/);
    expect(server.state.credentials).toHaveLength(0);
  });

  it.each([
    ['another network', { ...chargeRequest, methodDetails: { network: 'stellar:pubnet' } }],
    [
      'a server-sponsored charge',
      { ...chargeRequest, methodDetails: { network: 'stellar:testnet', feePayer: true } },
    ],
    [
      'no transaction credentials',
      {
        ...chargeRequest,
        methodDetails: { network: 'stellar:testnet', credentialTypes: ['signedHash'] },
      },
    ],
    ['a non-contract currency', { ...chargeRequest, currency: RECIPIENT }],
  ])('rejects a challenge for %s', async (_label, request) => {
    server = await startServer(request);
    await expect(client.fetch(server.url)).rejects.toThrow();
    expect(server.state.credentials).toHaveLength(0);
    expect(spendingTracker.commit).not.toHaveBeenCalled();
  });

  it('rejects an expired challenge', async () => {
    server = await startServer(chargeRequest, {
      expires: new Date(Date.now() - 1000).toISOString(),
    });
    await expect(client.fetch(server.url)).rejects.toThrow(/expired/);
  });

  it.each([
    ['a different token', { contract: OTHER_SAC }],
    ['a different amount', { amount: 999_999_999n }],
  ])(
    'refuses to sign when simulation authorizes %s, and releases the reservation',
    async (_label, override) => {
      mockPrepare(override);
      server = await startServer(chargeRequest);

      await expect(client.fetch(server.url)).rejects.toBeInstanceOf(ValidationError);
      expect(server.state.credentials).toHaveLength(0);
      expect(spendingTracker.release).toHaveBeenCalledWith('res-1');
      expect(spendingTracker.commit).not.toHaveBeenCalled();
    }
  );
});
