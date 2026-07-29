"use strict";
/**
 * backend/rpc_client.ts
 * Thin wrapper around Horizon + Soroban RPC with retry logic and rate-limit awareness.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sorobanServer = exports.horizonServer = exports.RateLimitError = exports.StellarRPCError = exports.TimeoutError = exports.RPC_BREAKER_OPTIONS = void 0;
exports.attachBreakerTelemetry = attachBreakerTelemetry;
exports.createRpcBreaker = createRpcBreaker;
exports.resolveNetworkPassphrase = resolveNetworkPassphrase;
exports.DEFAULT_IS_RETRYABLE = DEFAULT_IS_RETRYABLE;
exports.withRetry = withRetry;
exports.withTimeout = withTimeout;
exports.loadAccount = loadAccount;
exports.submitTransaction = submitTransaction;
exports.simulateSorobanTx = simulateSorobanTx;
exports.prepareSorobanTx = prepareSorobanTx;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const crypto_1 = require("crypto");
const opossum_1 = __importDefault(require("opossum"));
const zod_1 = require("zod");
const config_1 = require("./config");
const logger_1 = require("./logger");
const xdr_1 = require("./types/xdr");
const logger_2 = require("./utils/logger");
const network_1 = require("./network");
const telemetry_1 = require("./telemetry");
const log = (0, logger_2.createLogger)("rpc-client");
// Exported so the breaker's behaviour can be asserted against the real
// thresholds rather than a copy that silently drifts from them (#244).
exports.RPC_BREAKER_OPTIONS = {
    errorThresholdPercentage: 50,
    resetTimeout: 30_000,
    timeout: 10_000,
    volumeThreshold: 5,
    rollingCountTimeout: 30_000,
    rollingCountBuckets: 10,
};
class RpcServiceUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "RpcServiceUnavailableError";
    }
}
const accountCache = new Map();
function attachBreakerTelemetry(breaker, name) {
    breaker.on("open", () => {
        log.warn({
            circuit: name,
            failures: breaker.stats.failures,
            successes: breaker.stats.successes,
            timeout: exports.RPC_BREAKER_OPTIONS.timeout,
            resetTimeout: exports.RPC_BREAKER_OPTIONS.resetTimeout,
        }, "RPC circuit opened");
    });
    breaker.on("halfOpen", () => {
        log.info({
            circuit: name,
        }, "RPC circuit half-open");
    });
    breaker.on("close", () => {
        log.info({
            circuit: name,
            failures: breaker.stats.failures,
            successes: breaker.stats.successes,
        }, "RPC circuit closed");
    });
    return breaker;
}
function createRpcBreaker(name, action) {
    return attachBreakerTelemetry(new opossum_1.default(action, {
        ...exports.RPC_BREAKER_OPTIONS,
        name,
    }), name);
}
function resolveNetworkPassphrase(network) {
    if (network === "mainnet")
        return stellar_sdk_1.Networks.PUBLIC;
    if (network === "futurenet")
        return stellar_sdk_1.Networks.FUTURENET;
    if (network === "testnet")
        return stellar_sdk_1.Networks.TESTNET;
    throw new Error(`Unsupported network: ${network}`);
}
class TimeoutError extends Error {
    constructor(ms) {
        super(`Transaction Timeout: request did not complete within ${ms}ms`);
        this.name = "TimeoutError";
    }
}
exports.TimeoutError = TimeoutError;
class StellarRPCError extends Error {
    cause;
    constructor(message, cause) {
        super(message);
        this.name = "StellarRPCError";
        this.cause = cause;
    }
}
exports.StellarRPCError = StellarRPCError;
class RateLimitError extends Error {
    retryAfterSeconds;
    constructor(retryAfterSeconds) {
        super(`Rate limited. Retry after ${retryAfterSeconds} seconds`);
        this.name = "RateLimitError";
        this.retryAfterSeconds = retryAfterSeconds;
    }
}
exports.RateLimitError = RateLimitError;
const SUBMIT_TIMEOUT_MS = 30_000;
function DEFAULT_IS_RETRYABLE(err) {
    if (err instanceof zod_1.ZodError)
        return false;
    if (err instanceof TypeError)
        return false;
    if (err instanceof RateLimitError)
        return true;
    return true;
}
async function withRetry(fn, retries = config_1.config.MAX_RETRIES, delayMs = config_1.config.RETRY_DELAY_MS, isRetryable = DEFAULT_IS_RETRYABLE, maxDelayMs = 30_000) {
    return (0, telemetry_1.withSpan)("withRetry", async () => {
        let lastErr;
        for (let attempt = 1; attempt <= retries; attempt++) {
            logger_1.logger.debug(`[withRetry] Attempt ${attempt}/${retries}: calling...`);
            try {
                // Check backoff before each attempt
                if ((0, network_1.isThrottled)()) {
                    throw new RateLimitError(30);
                }
                return await fn();
            }
            catch (err) {
                // Detect 429 from Horizon/Soroban responses
                if (err instanceof Error && err.message.includes("429")) {
                    (0, network_1.handleRateLimitResponse)(null);
                    lastErr = new RateLimitError(30);
                }
                else {
                    lastErr = err;
                }
                if (!isRetryable(err) && !(err instanceof RateLimitError)) {
                    throw err;
                }
                logger_1.logger.warn("Retry attempt failed", {
                    attempt,
                    maxRetries: retries,
                    error: err.message,
                });
                if (attempt < retries) {
                    const exponential = delayMs * Math.pow(2, attempt - 1);
                    const capped = Math.min(exponential, maxDelayMs);
                    const jitter = Math.random() * 0.2 * capped;
                    await new Promise((r) => setTimeout(r, capped + jitter));
                }
            }
        }
        const lastErrorMessage = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown error");
        throw new StellarRPCError(`RPC call failed after ${retries} attempt(s): ${lastErrorMessage}`, lastErr);
    }, { "rpc.maxRetries": retries });
}
function withTimeout(promise, ms) {
    let id;
    const timeout = new Promise((_, reject) => {
        id = setTimeout(() => reject(new TimeoutError(ms)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}
function createHorizonServer() {
    const requestId = (0, crypto_1.randomUUID)();
    return new stellar_sdk_1.Horizon.Server(config_1.config.HORIZON_URL, {
        allowHttp: config_1.config.STELLAR_NETWORK === "testnet" || config_1.config.STELLAR_NETWORK === "futurenet",
        headers: {
            "X-Request-ID": requestId,
        },
    });
}
exports.horizonServer = createHorizonServer();
async function loadAccount(publicKey) {
    return (0, network_1.withBackoffGuard)(() => withTimeout(withRetry(() => exports.horizonServer.loadAccount(publicKey), config_1.config.MAX_RETRIES, config_1.config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE), config_1.config.RPC_TIMEOUT_MS));
}
async function submitTransaction(tx) {
    (0, xdr_1.validateXDR)(tx.toEnvelope().toXDR("base64"));
    return (0, network_1.withBackoffGuard)(() => withRetry(() => {
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
    }));
}
function createSorobanServer() {
    const requestId = (0, crypto_1.randomUUID)();
    return new stellar_sdk_1.rpc.Server(config_1.config.SOROBAN_RPC_URL, {
        allowHttp: config_1.config.STELLAR_NETWORK === "testnet" || config_1.config.STELLAR_NETWORK === "futurenet",
        headers: {
            "X-Request-ID": requestId,
        },
    });
}
exports.sorobanServer = createSorobanServer();
async function simulateSorobanTx(tx) {
    return (0, network_1.withBackoffGuard)(() => withTimeout(withRetry(() => exports.sorobanServer.simulateTransaction(tx), config_1.config.MAX_RETRIES, config_1.config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE), config_1.config.RPC_TIMEOUT_MS));
}
function validateSorobanAuth(tx) {
    const operations = Array.isArray(tx.operations)
        ? tx.operations ?? []
        : [];
    for (const operation of operations) {
        const authEntries = Array.isArray(operation?.auth) ? operation.auth : [];
        for (const authEntry of authEntries) {
            const authObject = authEntry;
            const credentials = authObject.credentials?.();
            if (!credentials)
                continue;
            const hasAddressCredentials = typeof credentials.address === "function";
            if (!hasAddressCredentials) {
                continue;
            }
            const address = credentials.address?.();
            const innerAddress = address?.address?.();
            const accountId = innerAddress?.accountId?.();
            const ed25519 = accountId?.ed25519?.();
            const muxedEd25519 = accountId?.muxedEd25519?.();
            const rawKey = ed25519 ?? muxedEd25519?.ed25519?.();
            if (!rawKey) {
                throw new Error("Unexpected Soroban auth signer format");
            }
            const signer = stellar_sdk_1.StrKey.encodeEd25519PublicKey(Buffer.from(rawKey));
            if (signer !== config_1.config.AGENT_PUBLIC_KEY) {
                throw new Error(`Unexpected Soroban auth signer: ${signer}`);
            }
        }
    }
}
async function prepareSorobanTx(tx) {
    const simResult = await simulateSorobanTx(tx);
    if (stellar_sdk_1.rpc.Api.isSimulationError(simResult)) {
        throw new Error("Soroban simulation failed: ");
    }
    const builtTx = stellar_sdk_1.rpc.assembleTransaction(tx, simResult).build();
    validateSorobanAuth(builtTx);
    return builtTx;
}
//# sourceMappingURL=rpc_client.js.map