/**
 * tests/x402_interop.test.ts
 *
 * x402 v2 interoperability test suite.
 * Covers legacy path, v2 buyer, v2 seller middleware, flag isolation,
 * and facilitator validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { config, AgentConfig } from '../backend/config';
import { X402PaymentTool } from '../backend/tools/X402PaymentTool';
import { createX402Middleware } from '../backend/x402/server';
import { Express, Request, Response, NextFunction } from 'express';

// ─── Mock dependencies ────────────────────────────────────────────────────────

vi.mock('../backend/config', () => {
  const mockConfig: AgentConfig = {
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    AGENT_SECRET_KEY: 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
    AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    agentKeypair: () => ({
      publicKey: () => 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
    }),
    DB_PATH: ':memory:',
    STORAGE_BACKEND: 'sqlite' as const,
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    X402_ASSET_CONTRACT: 'CD5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    AGENT_SPENDING_LIMIT: '100',
    APPROVAL_TTL_MS: 3600000,
    PAYMENT_DESTINATION_POLICY: 'open' as const,
    PAYMENT_DESTINATIONS: [],
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    ALLOWED_X402_ORIGINS: undefined,
    X402_MAX_PRICE: undefined,
    X402_ALLOWED_ASSETS: undefined,
    AGENT_SECRET_KEY_ARN: undefined,
    SIGNER_BACKEND: 'local' as const,
    VAULT_TRANSIT_MOUNT: 'transit',
    VAULT_TRANSIT_KEY: undefined,
    SPENDING_WINDOW_MS: 86400000,
    ACCOUNT_CACHE_TTL_MS: 30000,
    RPC_TIMEOUT_MS: 6000,
    TOML_CACHE_TTL_MS: 300000,
    MAX_X402_PAYMENTS_PER_MINUTE: 10,
    X402_NONCE_TTL_MS: 86400000,
    MAX_SOROBAN_FEE_STROOPS: 1000000,
    MAX_FEE_STROOPS: 100000,
    MAX_CONCURRENT_TASKS: 10,
    QUEUE_CAPACITY: 0,
    MCP_ALLOW_PAYMENTS: false,
    MCP_TRANSPORT: 'stdio' as const,
    MCP_PORT: 3001,
    HEALTH_PORT: 3000,
    WEBHOOK_URL: undefined,
    WEBHOOK_SECRET: undefined,
    ADMIN_API_TOKEN: undefined,
    WEBHOOK_LEGACY_SIGNATURE: false,
    PAUSED: false,
    LLM_PROVIDER: 'mock' as const,
    LLM_MODEL: undefined,
    LLM_BASE_URL: undefined,
    LLM_TIMEOUT_MS: 60000,
    LLM_MAX_TOKENS: 4096,
    LLM_TEMPERATURE: 0.7,
    // New x402 v2 config fields
    X402_USE_LEGACY: false,
    X402_FACILITATOR_URL: 'https://facilitator.example.com',
  };

  return {
    config: mockConfig,
  };
});

vi.mock('../backend/signer', () => ({
  createAgentSigner: () => ({
    publicKey: () => 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  }),
  Signer: class {},
}));

vi.mock('../backend/rpc_client', () => ({
  withRetry: (fn: () => Promise<unknown>) => fn(),
  horizonServer: {
    ledgers: vi.fn().mockReturnValue({
      ledger: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ closed_at: new Date().toISOString() }),
      }),
    }),
    transactions: vi.fn().mockReturnValue({
      transaction: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ memo: '', _hash: '' }),
      }),
    }),
    operations: vi.fn().mockReturnValue({
      forTransaction: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ records: [] }),
      }),
    }),
  },
}));

vi.mock('../backend/tools/StellarPaymentTool', () => ({
  StellarPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: 'legacy_tx_hash', ledger: 99 }),
  })),
}));

vi.mock('@x402/stellar', () => ({
  ExactStellarScheme: vi.fn().mockImplementation(() => ({
    buildPayment: vi.fn().mockResolvedValue({
      send: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => name === 'x-transaction-hash' ? 'v2_tx_hash' : null,
        },
        json: () => Promise.resolve({ txHash: 'v2_tx_hash', ledger: 100 }),
      }),
    }),
  })),
  X402Challenge: {
    parse: (challenge: any) => challenge,
  },
}));

vi.mock('@x402/core', () => ({
  X402Payment: {
    build: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get: (name: string) => name === 'x-transaction-hash' ? 'v2_tx_hash' : null,
        },
        json: () => Promise.resolve({ txHash: 'v2_tx_hash', ledger: 100 }),
      }),
    })),
  },
  X402Challenge: {
    parse: (challenge: any) => challenge,
  },
}));

// ─── Helper functions ─────────────────────────────────────────────────────────

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function createValidChallenge(overrides: Record<string, unknown> = {}): any {
  return {
    resource: 'https://api.example.com/data',
    amount: '1.5000000',
    assetCode: 'USDC',
    assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    nonce: randomUUID(),
    expiresAt: futureIso(),
    ...overrides,
  };
}

function createV2Challenge(overrides: Record<string, unknown> = {}): any {
  return {
    ...createValidChallenge(overrides),
    x402Version: '2.0',
    network: 'stellar:testnet',
  };
}

function createV2ChallengeWithAccepts(overrides: Record<string, unknown> = {}): any {
  return {
    ...createValidChallenge(overrides),
    accepts: [
      {
        scheme: 'exact',
        type: 'payment',
        network: 'stellar:testnet',
        destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      },
    ],
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('x402 v2 Interoperability', () => {
  let originalX402_USE_LEGACY: string | undefined;
  let originalX402_FACILITATOR_URL: string | undefined;

  beforeAll(() => {
    originalX402_USE_LEGACY = process.env.X402_USE_LEGACY;
    originalX402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL;
  });

  afterAll(() => {
    if (originalX402_USE_LEGACY !== undefined) {
      process.env.X402_USE_LEGACY = originalX402_USE_LEGACY;
    } else {
      delete process.env.X402_USE_LEGACY;
    }
    if (originalX402_FACILITATOR_URL !== undefined) {
      process.env.X402_FACILITATOR_URL = originalX402_FACILITATOR_URL;
    } else {
      delete process.env.X402_FACILITATOR_URL;
    }
  });

  beforeEach(() => {
    // Reset to v2 default
    process.env.X402_USE_LEGACY = '0';
    process.env.X402_FACILITATOR_URL = 'https://facilitator.example.com';
    
    // Re-import config to pick up new env vars
    vi.resetModules();
  });

  describe('Legacy path (X402_USE_LEGACY=1)', () => {
    it('should use legacy SHA-256 memo flow when flag is enabled', async () => {
      // Set legacy mode
      process.env.X402_USE_LEGACY = '1';
      
      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();
      
      const challenge = createValidChallenge();
      
      // Mock the StellarPaymentTool for legacy path
      const mockExecute = vi.fn().mockResolvedValue({
        txHash: 'legacy_tx_hash_123',
        ledger: 101,
      });
      
      vi.doMock('../backend/tools/StellarPaymentTool', () => ({
        StellarPaymentTool: vi.fn().mockImplementation(() => ({
          execute: mockExecute,
        })),
      }));
      
      const result = await tool.respond(challenge);
      
      expect(result.protocol).toBe('x402');
      expect(result.txHash).toBe('legacy_tx_hash_123');
      expect(result.network).toBe('stellar:testnet');
      expect(mockExecute).toHaveBeenCalled();
    });

    it('should reject challenges with expired expiresAt', async () => {
      process.env.X402_USE_LEGACY = '1';
      
      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();
      
      const challenge = createValidChallenge({
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      
      await expect(tool.respond(challenge)).rejects.toThrow('x402 challenge expired');
    });
  });

  describe('V2 buyer path (X402_USE_LEGACY=0)', () => {
    it('should use v2 SEP-41 token transfer flow when flag is disabled', async () => {
      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();
      
      const challenge = createV2Challenge();
      
      const result = await tool.respond(challenge);
      
      expect(result.protocol).toBe('x402');
      expect(result.txHash).toBe('v2_tx_hash');
      expect(result.network).toBe('stellar:testnet');
      expect(result.nonce).toBe(challenge.nonce);
    });

    it('should handle challenges with accepts array containing exact scheme', async () => {
      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();
      
      const challenge = createV2ChallengeWithAccepts();
      
      const result = await tool.respond(challenge);
      
      expect(result.protocol).toBe('x402');
      expect(result.txHash).toBe('v2_tx_hash');
    });

    it('should use facilitator URL from config when available', async () => {
      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();
      
      const challenge = createV2Challenge();
      
      await tool.respond(challenge);
      
      // Verify that the ExactStellarScheme was instantiated with facilitatorUrl
      const { ExactStellarScheme } = await import('@x402/stellar');
      expect(ExactStellarScheme).toHaveBeenCalled();
      
      const instance = ExactStellarScheme.mock.instances[0];
      expect(instance.facilitatorUrl).toBe('https://facilitator.example.com');
    });

    it('should skip facilitator when X402_FACILITATOR_URL is not set', async () => {
      delete process.env.X402_FACILITATOR_URL;
      
      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();
      
      const challenge = createV2Challenge();
      
      const result = await tool.respond(challenge);
      
      expect(result.protocol).toBe('x402');
      expect(result.txHash).toBe('v2_tx_hash');
    });

    it('should throw error for non-v2 challenge when in v2 mode', async () => {
      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();
      
      const challenge = createValidChallenge(); // No x402Version field
      
      await expect(tool.respond(challenge)).rejects.toThrow(/x402 v2.*challenge does not contain required v2 fields/);
    });
  });

  describe('V2 seller middleware (Express)', () => {
    let app: any;

    beforeEach(() => {
      app = {
        use: vi.fn(),
        get: vi.fn(),
        post: vi.fn(),
      };
    });

    it('should create middleware that returns v2 challenges when X402_USE_LEGACY=false', async () => {
      delete process.env.X402_USE_LEGACY; // Use default (false)
      
      const { createX402Middleware } = await import('../backend/x402/server');
      const middleware = createX402Middleware();
      
      expect(middleware).toBeDefined();
    });

    it('should create legacy middleware that returns JSON when X402_USE_LEGACY=true', async () => {
      process.env.X402_USE_LEGACY = '1';
      
      const { createX402Middleware } = await import('../backend/x402/server');
      const middleware = createX402Middleware();
      
      expect(middleware).toBeDefined();
    });
  });

  describe('Flag isolation', () => {
    it('should respect X402_USE_LEGACY flag in config', async () => {
      process.env.X402_USE_LEGACY = '0';
      
      const config1 = (await import('../backend/config')).config;
      expect(config1.X402_USE_LEGACY).toBe(false);
      
      process.env.X402_USE_LEGACY = '1';
      
      const { config: config2 } = await import('../backend/config');
      expect(config2.X402_USE_LEGACY).toBe(true);
    });

    it('should have X402_USE_LEGACY default to false', async () => {
      delete process.env.X402_USE_LEGACY;
      
      const { config } = await import('../backend/config');
      expect(config.X402_USE_LEGACY).toBe(false);
    });
  });

  describe('Facilitator URL validation', () => {
    it('should validate X402_FACILITATOR_URL as valid URL', async () => {
      process.env.X402_FACILITATOR_URL = 'not-a-url';
      
      expect(() => (await import('../backend/config')).config).toThrow();
    });

    it('should accept valid URL for X402_FACILITATOR_URL', async () => {
      process.env.X402_FACILITATOR_URL = 'https://facilitator.example.com';
      
      const { config } = await import('../backend/config');
      expect(config.X402_FACILITATOR_URL).toBe('https://facilitator.example.com');
    });

    it('should allow X402_FACILITATOR_URL to be optional', async () => {
      delete process.env.X402_FACILITATOR_URL;
      
      const { config } = await import('../backend/config');
      expect(config.X402_FACILITATOR_URL).toBeUndefined();
    });
  });

  describe('Integration with agent.ts dispatch', () => {
    it('should route v2 challenges to respondV2 when X402_USE_LEGACY=false', async () => {
      process.env.X402_USE_LEGACY = '0';
      
      const { X402PaymentTool } = await import('../backend/tools/X402PaymentTool');
      const tool = new X402PaymentTool();
      
      // Mock the respondV2 method to verify it's called
      const respondV2Mock = vi.fn().mockResolvedValue({
        protocol: 'x402',
        network: 'stellar:testnet',
        txHash: 'v2_tx_hash',
        nonce: randomUUID(),
        payer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        signedAt: new Date().toISOString(),
      });
      
      tool.respondV2 = respondV2Mock;
      
      const challenge = createV2Challenge();
      await tool.respond(challenge);
      
      expect(respondV2Mock).toHaveBeenCalledWith(challenge);
    });
  });
});
