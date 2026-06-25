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
}
export declare function formatValidationErrors(errors: z.ZodError): string;
export declare const config: AgentConfig;
/**
 * Hardcoded spending limit (safety cap) for transactions on Stellar mainnet.
 * Any single operation/payment attempting to exceed this value will be blocked
 * by the spending limit assertion before submission.
 */
export declare const MAINNET_SPENDING_CAP = 10000;
//# sourceMappingURL=config.d.ts.map