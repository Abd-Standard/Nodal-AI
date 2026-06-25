/**
 * backend/config.ts
 *
 * Production-grade, schema-validated configuration layer.
 *
 * Security guarantees:
 *   - AGENT_SECRET_KEY is NEVER included in error messages or logs.
 *   - AGENT_PUBLIC_KEY is derived from the secret key at startup;
 *     only the public key is exposed on the config object.
 *   - Invalid env causes an informative error + process.exit(1)
 *     before any network or tool code runs.
 *
 * Usage:
 *   import { config } from "./config";
 *   config.HORIZON_URL          // validated URL string
 *   config.AGENT_PUBLIC_KEY     // derived G-address, safe to log
 *   config.agentKeypair()       // call-site requests the Keypair explicitly
 */

import { z } from "zod";
import * as dotenv from "dotenv";
import { Keypair } from "@stellar/stellar-sdk";
import { execSync } from "child_process";

// Load .env file (no-op when running in CI / production with real env vars)
dotenv.config();

// ─── Custom Zod refinements ───────────────────────────────────────────────────

/**
 * Validates a Stellar secret key (S…, 56 chars, base32).
 * The key itself is NEVER surfaced in Zod error messages —
 * we only report structural problems.
 */
const StellarSecretKeySchema = z
  .string()
  .refine(
    (val) => {
      try {
        Keypair.fromSecret(val);
        return true;
      } catch {
        return false;
      }
    },
    // Generic message — does not echo the value
    { message: "AGENT_SECRET_KEY is not a valid Stellar secret key (must start with S and be 56 chars)" }
  );

/**
 * Stellar public key — 56-char G-address.
 * Optional: when absent it is derived from AGENT_SECRET_KEY.
 */
const StellarPublicKeySchema = z
  .string()
  .length(56, "Must be a 56-character Stellar public key (G…)")
  .refine((val) => val.startsWith("G"), { message: "Public key must start with G" })
  .optional();

/**
 * Spending limit: a positive decimal with up to 7 decimal places.
 * "0" is not permitted — agents must have a non-zero spending cap.
 */
const SpendingLimitSchema = z
  .string()
  .regex(
    /^[1-9]\d*(\.\d{1,7})?$/,
    "AGENT_SPENDING_LIMIT must be a positive decimal (e.g. '100' or '50.0000000')"
  )
  .default("100");

// ─── Raw environment schema ───────────────────────────────────────────────────

const EnvSchema = z.object({
  // Network
  STELLAR_NETWORK: z
    .enum(["testnet", "mainnet", "futurenet"], {
      errorMap: () => ({
        message: "STELLAR_NETWORK must be one of: testnet | mainnet | futurenet",
      }),
    })
    .default("testnet"),

  // RPC endpoints
  HORIZON_URL: z
    .string({ required_error: "HORIZON_URL is required" })
    .url("HORIZON_URL must be a valid URL (e.g. https://horizon-testnet.stellar.org)"),

  SOROBAN_RPC_URL: z
    .string({ required_error: "SOROBAN_RPC_URL is required" })
    .url("SOROBAN_RPC_URL must be a valid URL (e.g. https://soroban-testnet.stellar.org)"),

  // Agent identity
  AGENT_SECRET_KEY: StellarSecretKeySchema,
  AGENT_PUBLIC_KEY: StellarPublicKeySchema,
  AGENT_SECRET_KEY_ARN: z.string().optional(),

  // x402 / PayFi asset
  X402_ASSET_CODE: z.string().min(1).max(12).default("USDC"),
  X402_ASSET_ISSUER: z
    .string({ required_error: "X402_ASSET_ISSUER is required" })
    .length(56, "X402_ASSET_ISSUER must be a 56-character Stellar address")
    .refine((val) => val.startsWith("G"), {
      message: "X402_ASSET_ISSUER must start with G",
    })
    .refine(
      (val) => {
        try {
          Keypair.fromPublicKey(val);
          return true;
        } catch {
          return false;
        }
      },
      {
        message:
          "X402_ASSET_ISSUER is not a valid Ed25519 public key",
      }
    ),
  ALLOWED_X402_ORIGINS: z.string().optional(),

  // Spending cap
  AGENT_SPENDING_LIMIT: SpendingLimitSchema,

  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Retry behaviour
  // Exponential back-off: delay = RETRY_DELAY_MS * 2^(attempt-1), capped at 30 000 ms,
  // plus ±20% random jitter. Example — MAX_RETRIES=3, RETRY_DELAY_MS=1500 →
  // delays [1500, 3000, 6000] ms (before jitter), not linear [1500, 3000, 4500].
  MAX_RETRIES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3),

  RETRY_DELAY_MS: z.coerce
    .number()
    .int()
    .min(100)
    .default(1500),

  // Per-call RPC timeout in milliseconds.
  // Defaults to RETRY_DELAY_MS * MAX_RETRIES * 2, computed post-parse.
  RPC_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .optional(),

  // Rate limiting
  MAX_X402_PAYMENTS_PER_MINUTE: z.coerce
    .number()
    .int()
    .min(1)
    .default(10),

  MAX_SOROBAN_FEE_STROOPS: z.coerce
    .number()
    .int()
    .min(100)
    .default(1_000_000),
});

type RawEnv = z.infer<typeof EnvSchema>;

// ─── Derived / enriched config type ──────────────────────────────────────────

export interface AgentConfig {
  /**
   * The Stellar network to target.
   * Enforced by EnvSchema to be one of: "testnet" | "mainnet" | "futurenet".
   * Defaults to "testnet".
   */
  readonly STELLAR_NETWORK: "testnet" | "mainnet" | "futurenet";

  /**
   * The Stellar Horizon server URL.
   * Validated by EnvSchema to be a valid URL string (e.g. "https://horizon-testnet.stellar.org").
   * Required.
   */
  readonly HORIZON_URL: string;

  /**
   * The Soroban RPC server URL.
   * Validated by EnvSchema to be a valid URL string (e.g. "https://soroban-testnet.stellar.org").
   * Required.
   */
  readonly SOROBAN_RPC_URL: string;

  /**
   * The asset code for the x402 / PayFi asset.
   * Validated by EnvSchema to be a string between 1 and 12 characters.
   * Defaults to "USDC".
   */
  readonly X402_ASSET_CODE: string;

  /**
   * The 56-character G-address of the issuer for the x402 / PayFi asset.
   * Validated by EnvSchema to be a 56-character Stellar public key starting with G.
   * Required.
   */
  readonly X402_ASSET_ISSUER: string;

  /**
   * The spending limit for the agent.
   * Validated by EnvSchema to be a positive decimal with up to 7 decimal places.
   * "0" is not permitted. Defaults to "100".
   */
  readonly AGENT_SPENDING_LIMIT: string;

  /**
   * The maximum number of retry attempts for transient network/RPC calls.
   * Validated by EnvSchema to be an integer between 1 and 10.
   * Defaults to 3.
   */
  readonly MAX_RETRIES: number;

  /**
   * The base delay in milliseconds for exponential back-off retries.
   * Validated by EnvSchema to be an integer of at least 100.
   * Defaults to 1500.
   */
  readonly RETRY_DELAY_MS: number;

  /**
   * Derived 56-character Stellar public key (G-address) for the agent.
   * Derived automatically from AGENT_SECRET_KEY, safe to log.
   */
  readonly AGENT_PUBLIC_KEY: string;

  /**
   * Returns the agent Keypair on demand.
   * Deliberately a function rather than a property so that callers are explicit
   * about accessing the secret key, preventing accidental printing/leakage.
   * The secret key is held securely in closure and never placed on the public config object.
   *
   * @example
   * ```typescript
   * // Safely sign a transaction using the derived keypair
   * const tx = new TransactionBuilder(account, ...)
   *   // ... add operations ...
   *   .build();
   * tx.sign(config.agentKeypair());
   * ```
   *
   * @example
   * ```typescript
   * // Safely access the secret key for tool instantiation
   * const secret = config.agentKeypair().secret();
   * const tool = new StellarPaymentTool(secret);
   * ```
   */
  readonly agentKeypair: () => Keypair;
  readonly ALLOWED_X402_ORIGINS?: string;
  readonly AGENT_SECRET_KEY_ARN?: string;
  /**
   * Per-call RPC timeout in milliseconds.
   * Defaults to RETRY_DELAY_MS * MAX_RETRIES * 2 when RPC_TIMEOUT_MS env var is absent.
   */
  readonly RPC_TIMEOUT_MS: number;

  /**
   * Maximum number of x402 payments allowed per 60-second sliding window.
   * Defaults to 10. Prevents rapid-fire calls from exhausting the agent balance.
   */
  readonly MAX_X402_PAYMENTS_PER_MINUTE: number;

  /**
   * Maximum Soroban transaction fee in stroops (1 stroop = 0.0000001 XLM).
   * Defaults to 1_000_000 (0.1 XLM). Prevents resource-inflated fee attacks.
   */
  readonly MAX_SOROBAN_FEE_STROOPS: number;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export function formatValidationErrors(errors: z.ZodError): string {
  return errors.issues
    .map((issue) => {
      const field = issue.path.join(".") || "unknown";
      // Redact any value that looks like a secret key
      const message = issue.message.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
      return `  • ${field}: ${message}`;
    })
    .join("\n");
}

/**
 * Loads, parses, and validates environment variables against the Zod schema.
 * Enforces spending caps, derivations, and network rules at startup.
 *
 * @returns The fully validated, read-only configuration instance.
 */
function loadConfig(): AgentConfig {
  if (process.env.AGENT_SECRET_KEY && process.env.AGENT_SECRET_KEY_ARN) {
    process.stderr.write("❌ [Config] Cannot specify both AGENT_SECRET_KEY and AGENT_SECRET_KEY_ARN.\n");
    process.exit(1);
  }

  if (process.env.AGENT_SECRET_KEY_ARN) {
    try {
      const arn = process.env.AGENT_SECRET_KEY_ARN;
      const region = arn.split(":")[3] || "us-east-1";
      const command = `node -e "
        const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
        const client = new SecretsManagerClient({ region: '${region}' });
        client.send(new GetSecretValueCommand({ SecretId: '${arn}' }))
          .then(res => {
            if (!res.SecretString) {
              console.error('No SecretString found in secret');
              process.exit(1);
            }
            process.stdout.write(res.SecretString);
          })
          .catch(err => {
            console.error(err.message);
            process.exit(1);
          });
      "`;
      const secret = execSync(command, { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
      let parsedSecret = secret;
      try {
        const json = JSON.parse(secret);
        if (json && typeof json === "object") {
          parsedSecret = json.AGENT_SECRET_KEY || Object.values(json)[0] as string;
        }
      } catch {
        // Not a JSON object, use raw string
      }
      process.env.AGENT_SECRET_KEY = parsedSecret;
    } catch (err: any) {
      process.stderr.write(`❌ [Config] Failed to fetch secret from AWS Secrets Manager (ARN: ${process.env.AGENT_SECRET_KEY_ARN}): ${err.stderr?.toString().trim() || err.message}\n`);
      process.exit(1);
    }
  }

  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    // Print structured errors — secret values are never echoed
    process.stderr.write(
      `\n❌ [Config] Invalid environment — fix the following before starting:\n` +
      formatValidationErrors(result.error) +
      `\n\nSee .env.example for reference.\n\n`
    );
    process.exit(1);
  }

  const raw: RawEnv = result.data;

  // ── Derive public key from secret ──────────────────────────────────────────
  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(raw.AGENT_SECRET_KEY);
  } catch {
    process.stderr.write("❌ [Config] Failed to derive keypair from AGENT_SECRET_KEY.\n");
    process.exit(1);
  }

  const derivedPublicKey = keypair.publicKey();

  // If AGENT_PUBLIC_KEY was explicitly provided, cross-check it matches
  if (raw.AGENT_PUBLIC_KEY && raw.AGENT_PUBLIC_KEY !== derivedPublicKey) {
    process.stderr.write(
      `❌ [Config] AGENT_PUBLIC_KEY does not match the key derived from AGENT_SECRET_KEY.\n` +
      `   Provided : ${raw.AGENT_PUBLIC_KEY}\n` +
      `   Derived  : ${derivedPublicKey}\n`
    );
    process.exit(1);
  }

  // ── Mainnet safety guard ───────────────────────────────────────────────────
  if (raw.STELLAR_NETWORK === "mainnet") {
    const limit = parseFloat(raw.AGENT_SPENDING_LIMIT);
    if (limit > 10_000) {
      process.stderr.write(
        `❌ [Config] AGENT_SPENDING_LIMIT (${raw.AGENT_SPENDING_LIMIT}) exceeds ` +
        `the mainnet safety cap of 10,000. Lower it or explicitly override.\n`
      );
      process.exit(1);
    }
  }

  // ── Build the config object — secret key stays in closure only ────────────
  const { AGENT_SECRET_KEY: _secret, AGENT_PUBLIC_KEY: _rawPub, ...rest } = raw;

  const rpcTimeoutMs =
    raw.RPC_TIMEOUT_MS ?? raw.RETRY_DELAY_MS * raw.MAX_RETRIES * 2;

  const cfg: AgentConfig = {
    ...rest,
    AGENT_PUBLIC_KEY: derivedPublicKey,
    RPC_TIMEOUT_MS: rpcTimeoutMs,
    MAX_X402_PAYMENTS_PER_MINUTE: raw.MAX_X402_PAYMENTS_PER_MINUTE,
    MAX_SOROBAN_FEE_STROOPS: raw.MAX_SOROBAN_FEE_STROOPS,
    // Secret is captured in closure; never on the object
    agentKeypair: () => Keypair.fromSecret(_secret),
  };

  // Startup banner — only safe fields
  process.stdout.write(
    `✅ [Config] Environment validated\n` +
    `   Network        : ${cfg.STELLAR_NETWORK}\n` +
    `   Horizon        : ${cfg.HORIZON_URL}\n` +
    `   Soroban        : ${cfg.SOROBAN_RPC_URL}\n` +
    `   Agent pubkey   : ${cfg.AGENT_PUBLIC_KEY}\n` +
    `   Spending limit : ${cfg.AGENT_SPENDING_LIMIT} ${cfg.X402_ASSET_CODE}\n` +
    `   Max retries    : ${cfg.MAX_RETRIES}\n`
  );

  return cfg;
}

// ─── Singleton — validated once at import time ────────────────────────────────
export const config: AgentConfig = loadConfig();

/**
 * Hardcoded spending limit (safety cap) for transactions on Stellar mainnet.
 * Any single operation/payment attempting to exceed this value will be blocked
 * by the spending limit assertion before submission.
 */
export const MAINNET_SPENDING_CAP = 10000;

// ─── Compile-time encapsulation guard ────────────────────────────────────────
// AgentConfig intentionally omits AGENT_SECRET_KEY via Omit<RawEnv, "AGENT_SECRET_KEY">.
// The line below must remain a type error; if tsc stops complaining here the
// Omit contract has been broken and the secret is leaking onto the public type.
// @ts-expect-error — AGENT_SECRET_KEY must NOT be accessible on AgentConfig
void (config.AGENT_SECRET_KEY satisfies never);
