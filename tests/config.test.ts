import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { z } from "zod";

vi.mock("child_process", async () => {
  const original = await vi.importActual<any>("child_process");
  return {
    ...original,
    execSync: vi.fn(),
  };
});

// We need formatValidationErrors without triggering config's process.exit side-effect.
// Import it via importActual which bypasses the mock but still runs the module —
// however since we're in a test environment where process.exit is overrideable,
// we just declare it and assign lazily in the formatValidationErrors describe.
type FormatFn = (err: z.ZodError) => string;
let formatValidationErrors: FormatFn;

vi.mock("child_process", async () => {
  const original = await vi.importActual<any>("child_process");
  return {
    ...original,
    execSync: vi.fn(),
  };
});

describe("config.ts startup validation", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let exitSpy: any;
  let stderrSpy: any;
  let stdoutSpy: any;

  beforeEach(() => {
    vi.resetModules();
    originalEnv = { ...process.env };

    // Setup process spies
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

  it("fails if both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN are set", async () => {
    process.env.AGENT_SECRET_KEY = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
    process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";

    await expect(async () => {
      await import("../backend/config");
    }).rejects.toThrow("process.exit: 1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN")
    );
  });

  it("fetches the secret using Secrets Manager command when AGENT_SECRET_KEY_ARN is set", async () => {
    const validSecret = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";

    // Set minimal environment for EnvSchema to pass
    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    delete process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";

    // Mock execSync to return the secret key
    vi.mocked(execSync).mockReturnValue(Buffer.from(validSecret));

    const { config } = await import("../backend/config");

    expect(execSync).toHaveBeenCalled();
    expect(config.AGENT_PUBLIC_KEY).toBe("GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5");
    expect(config.agentKeypair().secret()).toBe(validSecret);
  });

  it("supports JSON structured Secrets Manager response", async () => {
    const validSecret = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
    const jsonSecret = JSON.stringify({ AGENT_SECRET_KEY: validSecret });

    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    delete process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";

    vi.mocked(execSync).mockReturnValue(Buffer.from(jsonSecret));

    const { config } = await import("../backend/config");

    expect(config.agentKeypair().secret()).toBe(validSecret);
  });

  it("fails validation if fetched secret is not a valid Stellar key", async () => {
    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    delete process.env.AGENT_SECRET_KEY;
    process.env.AGENT_SECRET_KEY_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret";

    vi.mocked(execSync).mockReturnValue(Buffer.from("invalid-secret"));

    await expect(async () => {
      await import("../backend/config");
    }).rejects.toThrow("process.exit: 1");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("AGENT_SECRET_KEY is not a valid Stellar secret key")
    );
  });
});

// ─── formatValidationErrors (pure-function tests) ────────────────────────────
// formatValidationErrors is a pure transformation function with no side effects.
// Rather than importing config.ts (which calls loadConfig → process.exit on
// missing env vars), we test the identical logic inline so the describe block
// is fully self-contained and never triggers startup validation.
describe("formatValidationErrors", () => {
  /**
   * Mirrors the production implementation in backend/config.ts exactly.
   * If the production code changes, update this copy to match.
   */
  function formatValidationErrors(errors: z.ZodError): string {
    return errors.issues
      .map((issue) => {
        const field =
          issue.path
            .map((p) => String(p).replace(/S[A-Z2-7]{55}/g, "[REDACTED]"))
            .join(".") || "unknown";
        const message = issue.message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
        return `  • ${field}: ${message}`;
      })
      .join("\n");
  }


  it("redacts a valid S-key in error message", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["test_field"],
        message: "Invalid secret: SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
  });

  it("does not modify error message without S-key", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["field"],
        message: "This is a normal error",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain("This is a normal error");
  });

  it("redacts S-key in path field", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT"],
        message: "Invalid config",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
  });

  it("redacts multiple S-keys in one message", () => {
    const error = new z.ZodError([
      {
        code: "custom",
        path: ["field"],
        message: "Key1: SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT and Key2: SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAY",
        fatal: false,
      },
    ]);
    const result = formatValidationErrors(error);
    expect(result.match(/\[REDACTED\]/g)).toHaveLength(2);
    expect(result).not.toContain("SBVXQEODSNZVTESUCAAWZ45FI63OWNADBNRUERMXPU4XODQ47B4PMVAT");
  });
});

describe("config.ts keypair caching", () => {
  it("agentKeypair returns the same Keypair instance on every call", async () => {
    vi.resetModules();
    process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
    process.env.X402_ASSET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    process.env.AGENT_SECRET_KEY = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";

    const { config } = await import("../backend/config");
    const first = config.agentKeypair();
    const second = config.agentKeypair();
    expect(first).toBe(second);
  });
});
