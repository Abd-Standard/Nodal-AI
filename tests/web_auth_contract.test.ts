/**
 * tests/web_auth_contract.test.ts
 * SEP-45 Web Auth for contract (C…) accounts (#785) against a mock server.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Address,
  Keypair,
  Networks,
  StrKey,
  authorizeEntry,
  hash,
  nativeToScVal,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { randomBytes } from 'crypto';
import {
  StellarIdentityTool,
  SEP45_SIGNATURE_VALIDITY_LEDGERS,
  decodeAuthorizationEntries,
  encodeAuthorizationEntries,
} from '../backend/tools/StellarIdentityTool';
import { KeypairSigner } from '../backend/signer';
import type { StellarTomlTool } from '../backend/tools/StellarTomlTool';

vi.mock('../backend/rpc_client', () => ({
  withRetry: (fn: () => unknown) => fn(),
  sorobanServer: { getLatestLedger: vi.fn(async () => ({ sequence: 1000 })) },
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
  const secret = 'SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      MAX_RETRIES: 1,
      RETRY_DELAY_MS: 1,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const agentKp = Keypair.fromSecret('SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73');
const serverKp = Keypair.random();
const HOME_DOMAIN = 'anchor.example.com';
const ENDPOINT = 'https://auth.anchor.example.com/sep45/auth';
const WEB_AUTH_CONTRACT = StrKey.encodeContract(randomBytes(32));
const CONTRACT_ACCOUNT = StrKey.encodeContract(randomBytes(32));
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.sep45-token';

const TOML = {
  WEB_AUTH_FOR_CONTRACTS_ENDPOINT: ENDPOINT,
  WEB_AUTH_CONTRACT_ID: WEB_AUTH_CONTRACT,
  SIGNING_KEY: serverKp.publicKey(),
};

interface ChallengeOptions {
  args?: Record<string, string>;
  contract?: string;
  functionName?: string;
  serverSigner?: Keypair;
  subInvocation?: boolean;
}

function webAuthArgs(overrides: Record<string, string> = {}) {
  return {
    account: CONTRACT_ACCOUNT,
    home_domain: HOME_DOMAIN,
    web_auth_domain: 'auth.anchor.example.com',
    web_auth_domain_account: serverKp.publicKey(),
    nonce: randomBytes(16).toString('hex'),
    ...overrides,
  };
}

function invocationFor(opts: ChallengeOptions, args: Record<string, string>) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(opts.contract ?? WEB_AUTH_CONTRACT).toScAddress(),
        functionName: opts.functionName ?? 'web_auth_verify',
        args: [nativeToScVal(args)],
      })
    ),
    subInvocations: [],
  });
}

function entryFor(address: string, opts: ChallengeOptions, args: Record<string, string>) {
  const invocation = invocationFor(opts, args);
  if (opts.subInvocation) invocation.subInvocations([invocationFor(opts, args)]);
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: xdr.Int64.fromString('7'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: invocation,
  });
}

/** A challenge as a SEP-45 server would issue it: server entry signed, client entry unsigned. */
async function makeChallenge(opts: ChallengeOptions = {}): Promise<string> {
  const args = webAuthArgs(opts.args);
  const serverEntry = await authorizeEntry(
    entryFor(serverKp.publicKey(), opts, args),
    opts.serverSigner ?? serverKp,
    2000,
    Networks.TESTNET
  );
  return encodeAuthorizationEntries([entryFor(CONTRACT_ACCOUNT, opts, args), serverEntry]);
}

function mockServer(challenge: string, networkPassphrase = Networks.TESTNET) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (!init?.method || init.method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          authorization_entries: challenge,
          network_passphrase: networkPassphrase,
        }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ token: TOKEN }) } as Response;
  });
}

describe('StellarIdentityTool — SEP-45 contract accounts', () => {
  let tool: StellarIdentityTool;
  let fetchToml: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    fetchToml = vi.fn().mockResolvedValue(TOML);
    tool = new StellarIdentityTool(new KeypairSigner(agentKp), {
      fetchToml,
    } as unknown as StellarTomlTool);
  });

  it('round-trips encode/decode of SorobanAuthorizationEntries', async () => {
    const encoded = await makeChallenge();
    const entries = decodeAuthorizationEntries(encoded);
    expect(entries).toHaveLength(2);
    expect(encodeAuthorizationEntries(entries)).toBe(encoded);
  });

  it('verifies the challenge, signs the contract entry and returns the JWT', async () => {
    mockServer(await makeChallenge());

    const result = await tool.execute({
      homeDomain: HOME_DOMAIN,
      contractAccount: CONTRACT_ACCOUNT,
    });

    expect(result).toEqual({ token: TOKEN });
    expect(fetchToml).toHaveBeenCalledWith({ domain: HOME_DOMAIN });

    const [getUrl] = vi.mocked(fetch).mock.calls[0]!;
    const url = new URL(String(getUrl));
    expect(url.origin + url.pathname).toBe(ENDPOINT);
    expect(url.searchParams.get('account')).toBe(CONTRACT_ACCOUNT);
    expect(url.searchParams.get('home_domain')).toBe(HOME_DOMAIN);

    // The POST carries the client entry signed by the agent key for the contract account.
    const [postUrl, postInit] = vi.mocked(fetch).mock.calls[1]!;
    expect(postUrl).toBe(ENDPOINT);
    const { authorization_entries } = JSON.parse(String(postInit!.body));
    const clientEntry = decodeAuthorizationEntries(authorization_entries).find(
      (e) =>
        Address.fromScAddress(e.credentials().address().address()).toString() === CONTRACT_ACCOUNT
    )!;
    const creds = clientEntry.credentials().address();
    expect(creds.signatureExpirationLedger()).toBe(1000 + SEP45_SIGNATURE_VALIDITY_LEDGERS);

    const payload = hash(
      xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: hash(Buffer.from(Networks.TESTNET)),
          nonce: creds.nonce(),
          signatureExpirationLedger: creds.signatureExpirationLedger(),
          invocation: clientEntry.rootInvocation(),
        })
      ).toXDR()
    );
    const [sig] = scValToNative(creds.signature()) as Array<{
      public_key: Buffer;
      signature: Buffer;
    }>;
    expect(StrKey.encodeEd25519PublicKey(sig!.public_key)).toBe(agentKp.publicKey());
    expect(agentKp.verify(payload, sig!.signature)).toBe(true);
  });

  it.each<[string, ChallengeOptions, RegExp]>([
    [
      'a different contract',
      { contract: StrKey.encodeContract(randomBytes(32)) },
      /WEB_AUTH_CONTRACT_ID/,
    ],
    ['a different function', { functionName: 'transfer' }, /web_auth_verify/],
    ['sub-invocations', { subInvocation: true }, /sub-invocations/],
    ['a forged server signature', { serverSigner: Keypair.random() }, /not signed by the server/],
    ['another home_domain', { args: { home_domain: 'evil.example.com' } }, /home_domain/],
    ['another account', { args: { account: StrKey.encodeContract(randomBytes(32)) } }, /account/],
    [
      'another web_auth_domain',
      { args: { web_auth_domain: 'evil.example.com' } },
      /web_auth_domain/,
    ],
    ['an unrequested client_domain', { args: { client_domain: 'x.example.com' } }, /client_domain/],
  ])('rejects a challenge with %s and never posts it', async (_label, opts, error) => {
    mockServer(await makeChallenge(opts));

    await expect(
      tool.execute({ homeDomain: HOME_DOMAIN, contractAccount: CONTRACT_ACCOUNT })
    ).rejects.toThrow(error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a challenge for another network', async () => {
    mockServer(await makeChallenge(), Networks.PUBLIC);
    await expect(
      tool.execute({ homeDomain: HOME_DOMAIN, contractAccount: CONTRACT_ACCOUNT })
    ).rejects.toThrow(/network/);
  });

  it('requires the SEP-45 stellar.toml fields', async () => {
    fetchToml.mockResolvedValue({ SIGNING_KEY: serverKp.publicKey() });
    await expect(
      tool.execute({ homeDomain: HOME_DOMAIN, contractAccount: CONTRACT_ACCOUNT })
    ).rejects.toThrow(/WEB_AUTH_FOR_CONTRACTS_ENDPOINT/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a G-address as the contract account', async () => {
    await expect(
      tool.execute({ homeDomain: HOME_DOMAIN, contractAccount: agentKp.publicKey() })
    ).rejects.toThrow();
  });
});
