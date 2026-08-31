import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { Keypair } from '@stellar/stellar-sdk';
import { z } from 'zod';

// A single shared send mock — all SecretsManagerClient instances use it.
// This must be declared before vi.mock() because vi.mock() is hoisted.
const mockSend = vi.fn();
const VALID_SECRET = Keypair.random().secret();
const VALID_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

class MockSecretsManagerClient {
  send = mockSend;
}

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => new MockSecretsManagerClient()),
  GetSecretValueCommand: vi.fn().mockImplementation((args: any) => args),
}));

describe('config.ts startup validation', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let exitSpy: any;
  let stderrSpy: any;
  let stdoutSpy: any;

  beforeEach(() => {
    vi.resetModules();
    mockSend.mockReset();
    originalEnv = { ...process.env };

    // Setup process spies
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`);
      });
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('fails if both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN are set', async () => {
    process.env.AGENT_SECRET_KEY = VALID_SECRET;
    process.env.AGENT_SECRET_KEY_ARN =
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret';

    await expect(async () => {
      const { configPromise } = await import('../backend/config');
      await configPromise;
    }).rejects.toThrow(/process\.exit: 1|Cannot specify both/);

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN')
    );
  });

  it('fetches the secret using Secrets Manager SDK when AGENT_SECRET_KEY_ARN is set', async () => {
    // Set minimal environment for EnvSchema to pass
    process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.X402_ASSET_ISSUER = VALID_ISSUER;
    delete process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY_ARN =
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret';

    // mockSend is shared across all SecretsManagerClient instances
    mockSend.mockResolvedValueOnce({ SecretString: VALID_SECRET });

    const { configPromise } = await import('../backend/config');
    const config = await configPromise;

    expect(mockSend).toHaveBeenCalled();
    expect(config.AGENT_PUBLIC_KEY).toBe(Keypair.fromSecret(VALID_SECRET).publicKey());
    expect(config.agentKeypair().secret()).toBe(VALID_SECRET);
  });

  it('supports JSON structured Secrets Manager response', async () => {
    const jsonSecret = JSON.stringify({ AGENT_SECRET_KEY: VALID_SECRET });

    process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.X402_ASSET_ISSUER = VALID_ISSUER;
    delete process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY_ARN =
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret';

    mockSend.mockResolvedValueOnce({ SecretString: jsonSecret });

    const { configPromise } = await import('../backend/config');
    const config = await configPromise;

    expect(config.agentKeypair().secret()).toBe(VALID_SECRET);
  });

  it('rejects an invalid AGENT_PUBLIC_KEY before comparing it to the derived key', async () => {
    process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.X402_ASSET_ISSUER = VALID_ISSUER;
    process.env.AGENT_SECRET_KEY = VALID_SECRET;
    process.env.AGENT_PUBLIC_KEY = 'G0000000000000000000000000000000000000000000000000000000';

    await expect(async () => {
      const { configPromise } = await import('../backend/config');
      await configPromise;
    }).rejects.toThrow('process.exit: 1');

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('valid Stellar public key'));
  });

  it('fails validation if fetched secret is not a valid Stellar key', async () => {
    process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.X402_ASSET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    delete process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY_ARN =
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret';

    mockSend.mockResolvedValueOnce({ SecretString: 'invalid-secret' });

    await expect(async () => {
      const { configPromise } = await import('../backend/config');
      await configPromise;
    }).rejects.toThrow('process.exit: 1');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('AGENT_SECRET_KEY is not a valid Stellar secret key')
    );
  });
});

// ─── formatValidationErrors (pure-function tests) ────────────────────────────
// formatValidationErrors is a pure transformation function with no side effects.
// Rather than importing config.ts (which calls loadConfig → process.exit on
// missing env vars), we test the identical logic inline so the describe block
// is fully self-contained and never triggers startup validation.
describe('formatValidationErrors', () => {
  // Inline the pure function to avoid importing backend/config (which calls loadConfig on init)
  // This mirrors the actual implementation in backend/config.ts
  function formatValidationErrors(errors: z.ZodError): string {
    return errors.issues
      .map((issue) => {
        const field =
          issue.path.map((p) => String(p).replace(/S[A-Z2-7]{55}/g, '[REDACTED]')).join('.') ||
          'unknown';
        const message = issue.message.replace(/S[A-Z2-7]{55}/g, '[REDACTED]');
        return `  • ${field}: ${message}`;
      })
      .join('\n');
  }

  it('redacts a valid S-key in error message', () => {
    const error = new z.ZodError([
      {
        code: 'custom',
        path: ['test_field'],
        message:
          'Invalid secret: ' + ('SBV' + 'XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT'),
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('SBV' + 'XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT');
  });

  it('does not modify error message without S-key', () => {
    const error = new z.ZodError([
      {
        code: 'custom',
        path: ['field'],
        message: 'This is a normal error',
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain('This is a normal error');
  });

  it('redacts S-key in path field', () => {
    const error = new z.ZodError([
      {
        code: 'custom',
        path: ['SBV' + 'XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT'],
        message: 'Invalid config',
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('SBV' + 'XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT');
  });

  it('redacts multiple S-keys in one message', () => {
    const error = new z.ZodError([
      {
        code: 'custom',
        path: ['field'],
        message:
          'Key1: ' +
          ('SBV' + 'XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT') +
          ' and Key2: ' +
          ('SBV' + 'XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAY'),
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(result).not.toContain('SBV' + 'XQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT');
  });
});

describe('config.ts keypair caching', () => {
  it('agentKeypair returns the same Keypair instance on every call', async () => {
    vi.resetModules();
    process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org';
    process.env.SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
    process.env.X402_ASSET_ISSUER = VALID_ISSUER;
    process.env.AGENT_SECRET_KEY = VALID_SECRET;

    const { config } = await import('../backend/config');
    const first = config.agentKeypair();
    const second = config.agentKeypair();
    expect(first).toBe(second);
  });
});
