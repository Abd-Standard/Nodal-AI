/**
 * backend/rpc_client.ts
 * Thin wrapper around Horizon + Soroban RPC with retry logic.
 * All network calls route through here — centralised observability point.
 */

import {
  Horizon,
  Networks,
  rpc,
  Transaction,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import { ZodError } from "zod";
import { config } from "./config";
import { logger } from "./logger";
import { validateXDR } from "./types/xdr";
import { createLogger } from "./utils/logger";

const log = createLogger("rpc-client");

// ─── Network passphrase resolver ─────────────────────────────────────────────

/**
 * Map a STELLAR_NETWORK string to its canonical network passphrase.
 * Throws for any unrecognised network string so callers fail fast rather than
 * silently defaulting to the wrong passphrase.
 */
export function resolveNetworkPassphrase(network: string): string {
  if (network === "mainnet") return Networks.PUBLIC;
  if (network === "futurenet") return Networks.FUTURENET;
  if (network === "testnet") return Networks.TESTNET;
  throw new Error(`Unsupported network: ${network}`);
}

// ─── Timeout error ────────────────────────────────────────────────────────────

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Transaction Timeout: request did not complete within ${ms}ms`);
    this.name = "TimeoutError";
  }
}

// ─── RPC error ────────────────────────────────────────────────────────────────

/** Wraps the final error thrown after all retry attempts are exhausted. */
export class StellarRPCError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "StellarRPCError";
    this.cause = cause;
  }
}

const SUBMIT_TIMEOUT_MS = 30_000;

// ─── Exponential back-off retry ─────────────────────────────────────────────

/**
 * Returns false for deterministic failures (ZodError, TypeError) that will
 * never succeed on retry, true for transient errors worth retrying.
 */
export function DEFAULT_IS_RETRYABLE(err: unknown): boolean {
  if (err instanceof ZodError) return false;
  if (err instanceof TypeError) return false;
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
export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = config.MAX_RETRIES,
  delayMs = config.RETRY_DELAY_MS,
  isRetryable: (err: unknown) => boolean = DEFAULT_IS_RETRYABLE,
  maxDelayMs = 30_000
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    logger.debug(`[withRetry] Attempt ${attempt}/${retries}: calling...`);
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) {
        throw err;
      }
      lastErr = err;
      const outcome = attempt < retries ? "retrying..." : "giving up";
      logger.warn(`Attempt ${attempt}/${retries} failed, ${outcome}`, {
        attempt,
        maxRetries: retries,
        error: (err as Error).message,
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
  throw new StellarRPCError(
    `RPC call failed after ${retries} attempt${retries !== 1 ? "s" : ""}: ${(lastErr as Error).message}`,
    lastErr
  );
}

// ─── Timeout wrapper ──────────────────────────────────────────────────────────

/**
 * Wraps a promise in a race against a timeout.
 * Throws TimeoutError if the promise does not resolve within `ms` milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
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
export const horizonServer = new Horizon.Server(config.HORIZON_URL, {
  allowHttp: config.STELLAR_NETWORK === "testnet" || config.STELLAR_NETWORK === "futurenet",
});

/**
 * Loads account details from the Horizon network for a given public key.
 *
 * @param publicKey - The 56-character Stellar public key (G-address) of the account.
 * @returns A promise resolving to the Horizon account details.
 * @throws An error if the account cannot be loaded after retries.
 */
export async function loadAccount(publicKey: string) {
  return withTimeout(
    withRetry(() => horizonServer.loadAccount(publicKey), config.MAX_RETRIES, config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE),
    config.RPC_TIMEOUT_MS
  );
}

/**
 * Submits a signed transaction to the Stellar network via Horizon.
 *
 * @param tx - The Transaction or FeeBumpTransaction to submit.
 * @returns A promise resolving to the Horizon transaction submission response.
 * @throws A TimeoutError if submission does not complete within 30 seconds.
 * @throws An error if the transaction payload is rejected or submission fails.
 */
export async function submitTransaction(tx: Transaction | FeeBumpTransaction) {
  // Guard: validate XDR encoding before initiating any network call
  validateXDR(tx.toEnvelope().toXDR("base64"));

  return withRetry(() => {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(SUBMIT_TIMEOUT_MS));
      }, SUBMIT_TIMEOUT_MS);
    });

    return Promise.race([
      horizonServer.submitTransaction(tx),
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
export const sorobanServer = new rpc.Server(config.SOROBAN_RPC_URL, {
  allowHttp: config.STELLAR_NETWORK === "testnet" || config.STELLAR_NETWORK === "futurenet",
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
export async function simulateSorobanTx(tx: Transaction) {
  return withTimeout(
    withRetry(() => sorobanServer.simulateTransaction(tx), config.MAX_RETRIES, config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE),
    config.RPC_TIMEOUT_MS
  );
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
export async function prepareSorobanTx(tx: Transaction): Promise<Transaction> {
  const simResult = await simulateSorobanTx(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Soroban simulation failed: ${(simResult as any).error}`);
  }

  return rpc.assembleTransaction(tx, simResult).build();
}
