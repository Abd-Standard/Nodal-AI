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
import { Keypair } from "@stellar/stellar-sdk";
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
     * Path to the SQLite database file used for audit persistence.
     * Defaults to "./agent.db". Use ":memory:" for in-process tests.
     */
    readonly DB_PATH: string;
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
     * OpenTelemetry collector endpoint.
     * Optional — when set, the agent exports traces/spans to this OTLP-compatible endpoint.
     * Validated by EnvSchema to be a valid URL string.
     */
    readonly OTLP_ENDPOINT?: string | undefined;
    /**
     * Spending window in milliseconds for rate/cap computation.
     * Defines the time window over which spending is tracked and enforced.
     * Validated by EnvSchema to be a positive integer.
     * Defaults to 60,000 (1 minute).
     */
    readonly SPENDING_WINDOW_MS: number;
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
    /**
     * Maximum number of tasks allowed to execute concurrently in agent.run().
     * Additional tasks submitted while this many are in flight are rejected.
     * Defaults to 10.
     */
    readonly MAX_CONCURRENT_TASKS: number;
    /**
     * Bounded FIFO queue capacity for tasks submitted while at MAX_CONCURRENT_TASKS.
     * Defaults to 0 (no queuing — excess tasks are rejected immediately).
     */
    readonly QUEUE_CAPACITY: number;
    /**
     * Port for the health-check HTTP server.
     * Validated by EnvSchema to be an integer between 1 and 65535.
     * Defaults to 3000.
     */
    readonly HEALTH_PORT: number;
    readonly CONTRACT_EVENT_POLL_MS?: number | undefined;
    readonly WEBHOOK_URL?: string | undefined;
    readonly WEBHOOK_SECRET?: string | undefined;
}
export declare function formatValidationErrors(errors: z.ZodError): string;
export declare function loadConfig(): Promise<AgentConfig>;
export declare const configPromise: Promise<AgentConfig>;
export declare const config: AgentConfig;
/**
 * Hardcoded spending limit (safety cap) for transactions on Stellar mainnet.
 * Any single operation/payment attempting to exceed this value will be blocked
 * by the spending limit assertion before submission.
 */
export declare const MAINNET_SPENDING_CAP = 10000;
//# sourceMappingURL=config.d.ts.map