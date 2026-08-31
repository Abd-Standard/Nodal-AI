/**
 * tests/stellar_toml.test.ts
 * Unit tests for StellarTomlTool with mocked HTTPS responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { StellarTomlTool } from '../backend/tools/StellarTomlTool';

vi.mock('axios');

vi.mock('../backend/config', () => ({
  config: {
    TOML_CACHE_TTL_MS: 300_000,
  },
}));

describe('StellarTomlTool', () => {
  let tool: StellarTomlTool;

  const mockTomlContent = `
VERSION = "2.0.0"

ACCOUNTS = [
  "GABCD1234567890ACCOUNT1",
  "GABCD1234567890ACCOUNT2"
]

[DOCUMENTATION]
ORG_NAME = "Example Org"
ORG_URL = "https://example.com"

[[CURRENCIES]]
CODE = "USDC"
ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

[[PRINCIPALS]]
NAME = "Alice"
EMAIL = "alice@example.com"
`;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new StellarTomlTool(300_000);
  });

  it('fetches and parses stellar.toml successfully with typed fields', async () => {
    (axios.get as any).mockResolvedValue({
      data: mockTomlContent,
    });

    const res = await tool.fetchToml({ domain: 'example.com' });

    expect(axios.get).toHaveBeenCalledWith('https://example.com/.well-known/stellar.toml', {
      responseType: 'text',
      timeout: 10000,
    });

    expect(res.DOCUMENTATION?.ORG_NAME).toBe('Example Org');
    expect(res.CURRENCIES).toHaveLength(1);
    expect(res.CURRENCIES?.[0].CODE).toBe('USDC');
    expect(res.PRINCIPALS?.[0].NAME).toBe('Alice');
    expect(res.ACCOUNTS).toEqual(['GABCD1234567890ACCOUNT1', 'GABCD1234567890ACCOUNT2']);
  });

  it('caches results for the configured TTL', async () => {
    (axios.get as any).mockResolvedValue({
      data: mockTomlContent,
    });

    const res1 = await tool.fetchToml({ domain: 'example.com' });
    const res2 = await tool.fetchToml({ domain: 'example.com' });

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(res1).toBe(res2);
  });

  it('fetches again after cache expiration or clearCache()', async () => {
    (axios.get as any).mockResolvedValue({
      data: mockTomlContent,
    });

    // Tool with 10ms TTL
    const shortTtlTool = new StellarTomlTool(10);
    await shortTtlTool.fetchToml({ domain: 'example.com' });

    // Wait 20ms to expire
    await new Promise((r) => setTimeout(r, 20));

    await shortTtlTool.fetchToml({ domain: 'example.com' });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it('throws ZodError on invalid input domain', async () => {
    await expect(tool.fetchToml({ domain: '' })).rejects.toThrow();
  });
});
