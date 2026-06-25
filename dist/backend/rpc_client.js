"use strict";
/**
 * backend/rpc_client.ts
 * Thin wrapper around Horizon + Soroban RPC with retry logic.
 * All network calls route through here — centralised observability point.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sorobanServer = exports.horizonServer = exports.StellarRPCError = exports.TimeoutError = void 0;
exports.resolveNetworkPassphrase = resolveNetworkPassphrase;
exports.DEFAULT_IS_RETRYABLE = DEFAULT_IS_RETRYABLE;
exports.withRetry = withRetry;
exports.withTimeout = withTimeout;
exports.loadAccount = loadAccount;
exports.submitTransaction = submitTransaction;
exports.simulateSorobanTx = simulateSorobanTx;
exports.prepareSorobanTx = prepareSorobanTx;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("./config");
const logger_1 = require("./logger");
const xdr_1 = require("./types/xdr");
const logger_2 = require("./utils/logger");
const log = (0, logger_2.createLogger)("rpc-client");
// ─── Network passphrase resolver ─────────────────────────────────────────────
/**
 * Map a STELLAR_NETWORK string to its canonical network passphrase.
 * Throws for any unrecognised network string so callers fail fast rather than
 * silently defaulting to the wrong passphrase.
 */
function resolveNetworkPassphrase(network) {
    if (network === "mainnet")
        return stellar_sdk_1.Networks.PUBLIC;
    if (network === "futurenet")
        return stellar_sdk_1.Networks.FUTURENET;
    if (network === "testnet")
        return stellar_sdk_1.Networks.TESTNET;
    throw new Error(`Unsupported network: ${network}`);
}
// ─── Timeout error ────────────────────────────────────────────────────────────
class TimeoutError extends Error {
    constructor(ms) {
        super(`Transaction Timeout: request did not complete within ${ms}ms`);
        this.name = "TimeoutError";
    }
}
exports.TimeoutError = TimeoutError;
// ─── RPC error ────────────────────────────────────────────────────────────────
/** Wraps the final error thrown after all retry attempts are exhausted. */
class StellarRPCError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.name = "StellarRPCError";
        this.cause = cause;
    }
}
exports.StellarRPCError = StellarRPCError;
const SUBMIT_TIMEOUT_MS = 30_000;
// ─── Exponential back-off retry ─────────────────────────────────────────────
/**
 * Returns false for deterministic failures (ZodError, TypeError) that will
 * never succeed on retry, true for transient errors worth retrying.
 */
function DEFAULT_IS_RETRYABLE(err) {
    if (err instanceof zod_1.ZodError)
        return false;
    if (err instanceof TypeError)
        return false;
    return true;
}
/**
 * Executes a promise-returning function with exponential back-off retry logic.
 *
 * @param fn - The asynchronous function to execute.
 * @param retries - The maximum number of retry attempts. Defaults to config.MAX_RETRIES.
 * @param delayMs - The initial delay in milliseconds before the first retry. Defaults to config.RETRY_DELAY_MS.
 * @param isRetryable - A callback that checks if the error is transient/retryable. Defaults to DEFAULT_IS_RETRYABLE.
 * @param maxDelayMs - The maximum delay limit in milliseconds for exponential back-off. Defaults to 30,000 ms.
 * @returns A promise that resolves to the result of the function if it succeeds.
 * @throws The last encountered error if all retry attempts fail, or the error immediately if it is not retryable.
 *
 * @remarks
 * The function uses true exponential back-off:
 * `delay = delayMs * 2^(attempt - 1)` capped at `maxDelayMs`.
 * It also applies a ±20% random jitter to the capped delay to prevent thundering herd problems
 * across multiple simultaneous agent instances.
 */
async function withRetry(fn, retries = config_1.config.MAX_RETRIES, delayMs = config_1.config.RETRY_DELAY_MS, isRetryable = DEFAULT_IS_RETRYABLE, maxDelayMs = 30_000) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            if (!isRetryable(err)) {
                throw err;
            }
            lastErr = err;
            logger_1.logger.warn("Retry attempt failed", {
                attempt,
                maxRetries: retries,
                error: err.message,
            });
            if (attempt < retries) {
                // True exponential back-off: 1500 → 3000 → 6000 ms for RETRY_DELAY_MS=1500
                const exponential = delayMs * Math.pow(2, attempt - 1);
                const capped = Math.min(exponential, maxDelayMs);
                // ±20% jitter to prevent thundering herd across simultaneous agent instances
                const jitter = Math.random() * 0.2 * capped;
                await new Promise((r) => setTimeout(r, capped + jitter));
            }
        }
    }
    throw new StellarRPCError(`RPC call failed after ${retries} attempt${retries !== 1 ? "s" : ""}: ${lastErr.message}`, lastErr);
}
// ─── Timeout wrapper ──────────────────────────────────────────────────────────
/**
 * Wraps a promise in a race against a timeout.
 * Throws TimeoutError if the promise does not resolve within `ms` milliseconds.
 */
function withTimeout(promise, ms) {
    let id;
    const timeout = new Promise((_, reject) => {
        id = setTimeout(() => reject(new TimeoutError(ms)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}
// ─── Horizon client ──────────────────────────────────────────────────────────
/**
 * Horizon server instance client.
 *
 * @remarks
 * The `allowHttp` configuration flag uses an explicit allowlist: only testnet and futurenet permit HTTP.
 * On mainnet, this client strictly enforces secure HTTPS connections to protect transaction transmission.
 * This prevents misconfiguration (e.g., "Mainnet" with capital M) from enabling plaintext connections.
 */
exports.horizonServer = new stellar_sdk_1.Horizon.Server(config_1.config.HORIZON_URL, {
    allowHttp: config_1.config.STELLAR_NETWORK === "testnet" || config_1.config.STELLAR_NETWORK === "futurenet",
});
/**
 * Loads account details from the Horizon network for a given public key.
 *
 * @param publicKey - The 56-character Stellar public key (G-address) of the account.
 * @returns A promise resolving to the Horizon account details.
 * @throws An error if the account cannot be loaded after retries.
 */
async function loadAccount(publicKey) {
    return withTimeout(withRetry(() => exports.horizonServer.loadAccount(publicKey), config_1.config.MAX_RETRIES, config_1.config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE), config_1.config.RPC_TIMEOUT_MS);
}
/**
 * Submits a signed transaction to the Stellar network via Horizon.
 *
 * @param tx - The Transaction or FeeBumpTransaction to submit.
 * @returns A promise resolving to the Horizon transaction submission response.
 * @throws A TimeoutError if submission does not complete within 30 seconds.
 * @throws An error if the transaction payload is rejected or submission fails.
 */
async function submitTransaction(tx) {
    // Guard: validate XDR encoding before initiating any network call
    (0, xdr_1.validateXDR)(tx.toEnvelope().toXDR("base64"));
    return withRetry(() => {
        const controller = new AbortController();
        let timeoutId;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                controller.abort();
                reject(new TimeoutError(SUBMIT_TIMEOUT_MS));
            }, SUBMIT_TIMEOUT_MS);
        });
        return Promise.race([
            exports.horizonServer.submitTransaction(tx),
            timeoutPromise,
        ]).finally(() => clearTimeout(timeoutId));
    });
}
// ─── Soroban RPC client ───────────────────────────────────────────────────────
/**
 * Soroban RPC server instance client.
 *
 * @remarks
 * The `allowHttp` flag uses an explicit allowlist: only testnet and futurenet permit HTTP.
 * On mainnet, HTTPS is enforced. Caution: sending mainnet transaction payloads or queries over plain HTTP
 * exposes sensitive network calls to eavesdropping or tampering.
 */
exports.sorobanServer = new stellar_sdk_1.rpc.Server(config_1.config.SOROBAN_RPC_URL, {
    allowHttp: config_1.config.STELLAR_NETWORK === "testnet" || config_1.config.STELLAR_NETWORK === "futurenet",
});
/**
 * Simulate a Soroban transaction BEFORE broadcasting.
 * Returns the simulation result — callers MUST check for errors.
 */
/**
 * Simulate a Soroban transaction BEFORE broadcasting.
 * Returns the simulation result — callers MUST check for errors.
 *
 * @param tx - The Transaction containing the Soroban invocations.
 * @returns A promise resolving to the Soroban RPC simulation result.
 * @throws An error if simulation RPC call fails after retries.
 */
async function simulateSorobanTx(tx) {
    return withTimeout(withRetry(() => exports.sorobanServer.simulateTransaction(tx), config_1.config.MAX_RETRIES, config_1.config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE), config_1.config.RPC_TIMEOUT_MS);
}
/**
 * Prepare (simulate + assemble) a Soroban transaction.
 * Throws if simulation indicates failure — safe guard before broadcast.
 *
 * @param tx - The Transaction to simulate and assemble.
 * @returns A promise resolving to the assembled Transaction.
 * @throws An Error if Soroban simulation fails. It checks the simulation response using the
 * `rpc.Api.isSimulationError` type guard. Callers should expect a throw if there is an execution failure,
 * insufficient budget, or invalid transaction envelope structure.
 */
async function prepareSorobanTx(tx) {
    const simResult = await simulateSorobanTx(tx);
    if (stellar_sdk_1.rpc.Api.isSimulationError(simResult)) {
        throw new Error(`Soroban simulation failed: ${simResult.error}`);
    }
    return stellar_sdk_1.rpc.assembleTransaction(tx, simResult).build();
}
//# sourceMappingURL=rpc_client.js.map