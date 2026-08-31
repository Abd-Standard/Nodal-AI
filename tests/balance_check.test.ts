import { describe, expect, it, vi } from 'vitest';
import { BalanceCheckInputSchema, BalanceCheckTool } from '../backend/tools/BalanceCheckTool';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({ loadAccount: vi.fn() }));

describe('BalanceCheckInputSchema', () => {
  const validPublicKey = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

  it('accepts valid Stellar public keys for both fields', () => {
    const parsed = BalanceCheckInputSchema.parse({
      publicKey: validPublicKey,
      assetIssuer: validPublicKey,
      assetCode: 'USDC',
    });

    expect(parsed.publicKey).toBe(validPublicKey);
    expect(parsed.assetIssuer).toBe(validPublicKey);
  });

  it('rejects a publicKey that is not a valid Ed25519 public key', () => {
    expect(() =>
      BalanceCheckInputSchema.parse({
        publicKey: 'G'.repeat(56),
        assetIssuer: validPublicKey,
        assetCode: 'USDC',
      })
    ).toThrow(/Invalid Stellar public key/);
  });

  it('retrieves the matching asset balance', async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: validPublicKey,
          balance: '2.5',
        },
      ],
    } as any);

    await expect(
      new BalanceCheckTool().execute({
        publicKey: validPublicKey,
        assetIssuer: validPublicKey,
        assetCode: 'USDC',
      })
    ).resolves.toBe('2.5');
  });

  it('returns zero when the asset balance is absent', async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue({ balances: [] } as any);
    await expect(
      new BalanceCheckTool().execute({
        publicKey: validPublicKey,
        assetIssuer: validPublicKey,
        assetCode: 'USDC',
      })
    ).resolves.toBe('0');
  });

  it('rejects an assetIssuer that is not a valid Ed25519 public key', () => {
    expect(() =>
      BalanceCheckInputSchema.parse({
        publicKey: validPublicKey,
        assetIssuer: 'G'.repeat(56),
        assetCode: 'USDC',
      })
    ).toThrow(/Invalid Stellar asset issuer/);
  });
});
