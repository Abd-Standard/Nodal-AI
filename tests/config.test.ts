import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Keypair } from '@stellar/stellar-sdk';
import { z } from 'zod';

// mockSend is declared at file scope so each test can prime it with
// mockSend.mockResolvedValueOnce() before the dynamic import triggers the
// AWS Secrets Manager fetch. The vi.mock factory closes over this reference,
// so after vi.resetModules() + vi.doMock() the same object is always used.
const mockSend = vi.fn();

const VALID_SECRET = Keypair.random().secret();
const VALID_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

class MockSecretsManagerClient {
  send = mockSend;
}

// Use vi.mock for the initial hoisted registration. Tests that call
// vi.resetModules() must call vi.doMock() in beforeEach to re-register the
// mock after the module registry is cleared (see beforeEach in the suites
// that use vi.resetModules()).
//
// The implementation is passed directly to vi.fn() (its "original"), not
// chained on afterward via .mockImplementation() — vitest.config.ts sets
// restoreMocks: true, which wipes a chained .mockImplementation() override
// between tests but leaves vi.fn()'s own baseline implementation intact.
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(() => new MockSecretsManagerClient()),
  GetSecretValueCommand: vi.fn((args: any) => args),
}));

describe('config.ts startup validation', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let exitSpy: any;
  let stderrSpy: any;
  let stdoutSpy: any;

  beforeEach(() => {
    vi.resetModules();
    // Re-register the AWS mock after resetModules clears the module registry.
    // vi.doMock (non-hoisted) runs after resetModules and ensures the next
    // dynamic import of backend/config picks up the mock rather than the real SDK.
    vi.doMock("@aws-sdk/client-secrets-manager", () => ({
      SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
      GetSecretValueCommand: vi.fn().mockImplementation((args: any) => args),
    }));
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

// ─── Issue #444: comprehensive config validation paths ───────────────────────
// Covers all validation cases requested in GitHub issue #444:
//   1. missing AGENT_SECRET_KEY (no ARN either)  → ConfigError / process.exit(1)
//   2. invalid STELLAR_NETWORK value             → process.exit(1)
//   3. AGENT_SPENDING_LIMIT > 10,000 on mainnet  → process.exit(1)
//   4. missing SOROBAN_RPC_URL                   → process.exit(1)
//   5. HTTP URL on mainnet (HTTPS refinement)    → process.exit(1)
//
// All tests use process.env injection (not the config singleton) and call
// vi.resetModules() so each dynamic import gets a fresh module instance,
// preventing any side effects on the shared singleton between tests.
describe("config.ts — comprehensive env-var validation (issue #444)", () => {
  // A known-good Stellar secret/public keypair used throughout this suite.
  const VALID_SECRET = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
  // A valid Stellar G-address used as X402_ASSET_ISSUER.
  const VALID_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  let originalEnv: NodeJS.ProcessEnv;
  let exitSpy: any;
  let stderrSpy: any;
  let stdoutSpy: any;

  beforeEach(() => {
    vi.resetModules();
    // Re-register the AWS mock after resetModules (same pattern as above).
    vi.doMock("@aws-sdk/client-secrets-manager", () => ({
      SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
      GetSecretValueCommand: vi.fn().mockImplementation((args: any) => args),
    }));
    mockSend.mockReset();
    // Snapshot the current env so we can restore it exactly after each test.
    originalEnv = { ...process.env };

    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
      throw new Error(`process.exit: ${code}`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  /**
   * Helper: set the minimal set of env vars that make EnvSchema happy on testnet,
   * then let individual tests override or delete specific keys.
   */
  function setMinimalValidEnv() {
    process.env.STELLAR_NETWORK = "testnet";
    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.X402_ASSET_ISSUER = VALID_ISSUER;
    process.env.AGENT_SECRET_KEY = VALID_SECRET;
    delete process.env.AGENT_SECRET_KEY_ARN;
  }

  // ── 1. Missing AGENT_SECRET_KEY ─────────────────────────────────────────────
  it("fails with a clear error when AGENT_SECRET_KEY is absent and no ARN is provided", async () => {
    setMinimalValidEnv();
    // Remove the secret key — no ARN fallback either
    delete process.env.AGENT_SECRET_KEY;
    delete process.env.AGENT_SECRET_KEY_ARN;

    await expect(async () => {
      const { configPromise } = await import("../backend/config");
      await configPromise;
    }).rejects.toThrow(/process\.exit: 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The Zod error for AGENT_SECRET_KEY should surface in stderr
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_SECRET_KEY")
    );
  });

  // ── 2. Invalid STELLAR_NETWORK value ────────────────────────────────────────
  it("fails when STELLAR_NETWORK is set to an unrecognised value", async () => {
    setMinimalValidEnv();
    process.env.STELLAR_NETWORK = "localnet"; // not in enum

    await expect(async () => {
      const { configPromise } = await import("../backend/config");
      await configPromise;
    }).rejects.toThrow(/process\.exit: 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("STELLAR_NETWORK must be one of: testnet | mainnet | futurenet")
    );
  });

  // ── 3. AGENT_SPENDING_LIMIT > 10,000 on mainnet ─────────────────────────────
  it("fails when AGENT_SPENDING_LIMIT exceeds 10,000 on mainnet", async () => {
    setMinimalValidEnv();
    // Switch to mainnet with HTTPS URLs (required by the HTTPS refinement) and
    // a spending limit that exceeds the 10,000 mainnet safety cap.
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.HORIZON_URL = "https://horizon.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-rpc.mainnet.stellar.org";
    process.env.AGENT_SPENDING_LIMIT = "10001";

    await expect(async () => {
      const { configPromise } = await import("../backend/config");
      await configPromise;
    }).rejects.toThrow(/process\.exit: 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("mainnet safety cap")
    );
  });

  // ── 4. Missing SOROBAN_RPC_URL ──────────────────────────────────────────────
  it("fails with a clear error when SOROBAN_RPC_URL is absent", async () => {
    setMinimalValidEnv();
    delete process.env.SOROBAN_RPC_URL;

    await expect(async () => {
      const { configPromise } = await import("../backend/config");
      await configPromise;
    }).rejects.toThrow(/process\.exit: 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("SOROBAN_RPC_URL")
    );
  });

  // ── 5. HTTP URL on mainnet — HTTPS refinement ───────────────────────────────
  it("fails when HORIZON_URL uses HTTP (not HTTPS) on mainnet", async () => {
    setMinimalValidEnv();
    process.env.STELLAR_NETWORK = "mainnet";
    // Intentionally HTTP — should be rejected by the mainnet HTTPS guard
    process.env.HORIZON_URL = "http://horizon.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-rpc.mainnet.stellar.org";
    process.env.AGENT_SPENDING_LIMIT = "100";

    await expect(async () => {
      const { configPromise } = await import("../backend/config");
      await configPromise;
    }).rejects.toThrow(/process\.exit: 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Mainnet requires HTTPS")
    );
  });

  it("fails when SOROBAN_RPC_URL uses HTTP (not HTTPS) on mainnet", async () => {
    setMinimalValidEnv();
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.HORIZON_URL = "https://horizon.stellar.org";
    // Intentionally HTTP — should be rejected by the mainnet HTTPS guard
    process.env.SOROBAN_RPC_URL = "http://soroban-rpc.mainnet.stellar.org";
    process.env.AGENT_SPENDING_LIMIT = "100";

    await expect(async () => {
      const { configPromise } = await import("../backend/config");
      await configPromise;
    }).rejects.toThrow(/process\.exit: 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Mainnet requires HTTPS")
    );
  });

  // ── Bonus: valid mainnet config (both HTTPS URLs, spending limit ≤ 10,000) passes ──
  it("accepts a valid mainnet configuration with HTTPS URLs and spending limit ≤ 10,000", async () => {
    setMinimalValidEnv();
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.HORIZON_URL = "https://horizon.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-rpc.mainnet.stellar.org";
    process.env.AGENT_SPENDING_LIMIT = "9999";
    process.env.WEBHOOK_SECRET = "mainnet-api-token";

    const { configPromise } = await import("../backend/config");
    const cfg = await configPromise;

    expect(cfg.STELLAR_NETWORK).toBe("mainnet");
    expect(cfg.AGENT_SPENDING_LIMIT).toBe("9999");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ── HTTP API auth guard (#738) ──────────────────────────────────────────────
  it("fails on mainnet when no API token is configured", async () => {
    setMinimalValidEnv();
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.HORIZON_URL = "https://horizon.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-rpc.mainnet.stellar.org";
    process.env.AGENT_SPENDING_LIMIT = "100";
    delete process.env.WEBHOOK_SECRET;
    delete process.env.ADMIN_API_TOKEN;

    await expect(async () => {
      const { configPromise } = await import("../backend/config");
      await configPromise;
    }).rejects.toThrow(/process\.exit: 1/);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("ADMIN_API_TOKEN is required on mainnet")
    );
  });

  it("warns once on testnet when no API token is configured", async () => {
    setMinimalValidEnv();
    delete process.env.WEBHOOK_SECRET;
    delete process.env.ADMIN_API_TOKEN;

    const { configPromise } = await import("../backend/config");
    await configPromise;

    expect(exitSpy).not.toHaveBeenCalled();
    const warnings = stderrSpy.mock.calls.filter(([msg]: [string]) =>
      String(msg).includes("ADMIN_API_TOKEN is not set")
    );
    expect(warnings).toHaveLength(1);
  });

  // ── Dedicated API token (#737) ──────────────────────────────────────────────
  it("warns that WEBHOOK_SECRET as the API token is deprecated", async () => {
    setMinimalValidEnv();
    process.env.WEBHOOK_SECRET = "legacy-secret";
    delete process.env.ADMIN_API_TOKEN;

    const { configPromise } = await import("../backend/config");
    await configPromise;

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Using WEBHOOK_SECRET as the HTTP API token is deprecated")
    );
  });

  it("accepts ADMIN_API_TOKEN on mainnet without a deprecation warning", async () => {
    setMinimalValidEnv();
    process.env.STELLAR_NETWORK = "mainnet";
    process.env.HORIZON_URL = "https://horizon.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-rpc.mainnet.stellar.org";
    process.env.AGENT_SPENDING_LIMIT = "100";
    process.env.ADMIN_API_TOKEN = "admin-token";
    delete process.env.WEBHOOK_SECRET;

    const { configPromise } = await import("../backend/config");
    const cfg = await configPromise;

    expect(cfg.ADMIN_API_TOKEN).toBe("admin-token");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalledWith(expect.stringContaining("deprecated"));
  });

  // ── Payment destination policy (#735) ───────────────────────────────────────
  it("merges PAYMENT_DESTINATIONS and PAYMENT_DESTINATIONS_FILE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nodal-dest-"));
    const file = join(dir, "destinations.txt");
    writeFileSync(file, `# merchants\nmerchant*example.com\n\n${VALID_ISSUER} # issuer\n`);
    setMinimalValidEnv();
    process.env.PAYMENT_DESTINATION_POLICY = "allowlist";
    process.env.PAYMENT_DESTINATIONS = "shop*example.org";
    process.env.PAYMENT_DESTINATIONS_FILE = file;

    const { configPromise } = await import("../backend/config");
    const cfg = await configPromise;

    expect(cfg.PAYMENT_DESTINATION_POLICY).toBe("allowlist");
    expect(cfg.PAYMENT_DESTINATIONS).toEqual([
      "shop*example.org",
      "merchant*example.com",
      VALID_ISSUER,
    ]);
  });

  it("fails when a payment destination is neither a G-address nor a federation name", async () => {
    setMinimalValidEnv();
    process.env.PAYMENT_DESTINATION_POLICY = "denylist";
    process.env.PAYMENT_DESTINATIONS = "not-an-address";
    delete process.env.PAYMENT_DESTINATIONS_FILE;

    await expect(async () => {
      const { configPromise } = await import("../backend/config");
      await configPromise;
    }).rejects.toThrow(/process\.exit: 1/);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("not-an-address"));
  });
});
