/**
 * tests/signers.test.ts
 *
 * Tests for the pluggable signer backends (#741). The Vault transit API is
 * mocked at the HTTP layer with a real Ed25519 keypair standing in for the
 * key held inside Vault, so signatures are verified end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  createSigner,
  LocalSigner,
  signTransaction,
  VaultTransitSigner,
} from '../backend/signers';

vi.mock('axios');

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    SIGNER_BACKEND: 'local' as 'local' | 'vault',
    VAULT_ADDR: undefined as string | undefined,
    VAULT_TRANSIT_MOUNT: 'transit',
    VAULT_TRANSIT_KEY: undefined as string | undefined,
    agentKeypair: (): unknown => undefined,
  },
}));

vi.mock('../backend/config', () => ({ config: mockConfig }));

const VAULT_ADDR = 'https://vault.example.com:8200';
const VAULT_TOKEN = 'hvs.test-token';
const KEY_NAME = 'nodal-agent';

function buildTx(source: string) {
  return new TransactionBuilder(new Account(source, '100'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      })
    )
    .setTimeout(30)
    .build();
}

/** Route axios calls to a fake Vault transit engine backed by `vaultKey`. */
function mockVault(vaultKey: Keypair, keyType = 'ed25519') {
  vi.mocked(axios.get).mockResolvedValue({
    data: {
      data: {
        type: keyType,
        latest_version: 1,
        keys: { '1': { public_key: vaultKey.rawPublicKey().toString('base64') } },
      },
    },
  } as any);

  vi.mocked(axios.post).mockImplementation((async (_url: string, body: any) => {
    const signature = vaultKey.sign(Buffer.from(body.input, 'base64'));
    return { data: { data: { signature: `vault:v1:${signature.toString('base64')}` } } };
  }) as any);
}

describe('LocalSigner', () => {
  it('signs with the wrapped keypair', async () => {
    const keypair = Keypair.random();
    const signer = new LocalSigner(keypair);
    const tx = buildTx(keypair.publicKey());

    await signTransaction(signer, tx);

    expect(signer.backend).toBe('local');
    expect(await signer.publicKey()).toBe(keypair.publicKey());
    expect(tx.signatures).toHaveLength(1);
    expect(keypair.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
  });
});

describe('VaultTransitSigner', () => {
  let vaultKey: Keypair;
  let signer: VaultTransitSigner;

  beforeEach(() => {
    vi.clearAllMocks();
    vaultKey = Keypair.random();
    mockVault(vaultKey);
    signer = new VaultTransitSigner({ address: VAULT_ADDR, token: VAULT_TOKEN, keyName: KEY_NAME });
  });

  it('derives the Stellar G-address from the Vault public key', async () => {
    expect(await signer.publicKey()).toBe(vaultKey.publicKey());
    expect(axios.get).toHaveBeenCalledWith(
      `${VAULT_ADDR}/v1/transit/keys/${KEY_NAME}`,
      expect.objectContaining({ headers: { 'X-Vault-Token': VAULT_TOKEN } })
    );
  });

  it('caches the public key after the first lookup', async () => {
    await signer.publicKey();
    await signer.publicKey();

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('signs a transaction hash through Vault and attaches a valid signature', async () => {
    const tx = buildTx(vaultKey.publicKey());

    await signTransaction(signer, tx);

    expect(axios.post).toHaveBeenCalledWith(
      `${VAULT_ADDR}/v1/transit/sign/${KEY_NAME}`,
      { input: tx.hash().toString('base64') },
      expect.objectContaining({ headers: { 'X-Vault-Token': VAULT_TOKEN } })
    );
    expect(tx.signatures).toHaveLength(1);
    expect(vaultKey.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
  });

  it('uses a custom transit mount path', async () => {
    const custom = new VaultTransitSigner({
      address: `${VAULT_ADDR}/`,
      token: VAULT_TOKEN,
      keyName: KEY_NAME,
      mount: '/stellar-transit/',
    });

    await custom.sign(Buffer.alloc(32));

    expect(axios.post).toHaveBeenCalledWith(
      `${VAULT_ADDR}/v1/stellar-transit/sign/${KEY_NAME}`,
      expect.anything(),
      expect.anything()
    );
  });

  it('rejects a transit key that is not ed25519', async () => {
    mockVault(vaultKey, 'ecdsa-p256');

    await expect(signer.publicKey()).rejects.toThrow(/requires "ed25519"/);
  });

  it('rejects a malformed signature from Vault', async () => {
    vi.mocked(axios.post).mockResolvedValue({
      data: { data: { signature: 'vault:v1:AAAA' } },
    } as any);

    await expect(signer.sign(Buffer.alloc(32))).rejects.toThrow(/malformed signature/);
  });

  it('fails signTransaction when the Vault key does not match the signature', async () => {
    const otherKey = Keypair.random();
    vi.mocked(axios.post).mockImplementation((async (_url: string, body: any) => {
      const signature = otherKey.sign(Buffer.from(body.input, 'base64'));
      return { data: { data: { signature: `vault:v1:${signature.toString('base64')}` } } };
    }) as any);

    await expect(signTransaction(signer, buildTx(vaultKey.publicKey()))).rejects.toThrow();
  });
});

describe('createSigner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.SIGNER_BACKEND = 'local';
    mockConfig.VAULT_ADDR = undefined;
    mockConfig.VAULT_TRANSIT_KEY = undefined;
    delete process.env.VAULT_TOKEN;
  });

  it('returns a LocalSigner by default', () => {
    const keypair = Keypair.random();
    mockConfig.agentKeypair = () => keypair;

    const signer = createSigner();

    expect(signer).toBeInstanceOf(LocalSigner);
    expect(signer.backend).toBe('local');
  });

  it('returns a VaultTransitSigner when SIGNER_BACKEND=vault', async () => {
    const vaultKey = Keypair.random();
    mockVault(vaultKey);
    mockConfig.SIGNER_BACKEND = 'vault';
    mockConfig.VAULT_ADDR = VAULT_ADDR;
    mockConfig.VAULT_TRANSIT_KEY = KEY_NAME;
    process.env.VAULT_TOKEN = VAULT_TOKEN;

    const signer = createSigner();

    expect(signer).toBeInstanceOf(VaultTransitSigner);
    expect(await signer.publicKey()).toBe(vaultKey.publicKey());
  });

  it('throws when the vault backend is missing settings', () => {
    mockConfig.SIGNER_BACKEND = 'vault';
    mockConfig.VAULT_ADDR = VAULT_ADDR;

    expect(() => createSigner()).toThrow(/requires VAULT_ADDR, VAULT_TRANSIT_KEY and VAULT_TOKEN/);
  });
});
