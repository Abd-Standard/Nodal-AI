/**
 * backend/rpc_client.ts
 * Thin wrapper around Horizon + Soroban RPC with retry logic and rate-limit awareness.
 */

import {
  Horizon,
  Networks,
  rpc,
  Transaction,
  FeeBumpTransaction,
  xdr,
  StrKey,
} from "@stellar/stellar-sdk";
import { ZodError } from "zod";
import { config } from "./config";
import { logger } from "./logger";
import { validateXDR } from "./types/xdr";
import { createLogger } from "./utils/logger";
import { isThrottled, handleRateLimitResponse, withBackoffGuard } from "./network";

const log = createLogger("rpc-client");

export function resolveNetworkPassphrase(network: string): string {
  if (network === "mainnet") return Networks.PUBLIC;
  if (network === "futurenet") return Networks.FUTURENET;
  if (network === "testnet") return Networks.TESTNET;
  throw new Error("Unsupported network: ");
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super("Transaction Timeout: request did not complete within ms");
    this.name = "TimeoutError";
  }
}

export class StellarRPCError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "StellarRPCError";
    this.cause = cause;
  }
}

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("Rate limited. Retry after  seconds");
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const SUBMIT_TIMEOUT_MS = 30_000;

export function DEFAULT_IS_RETRYABLE(err: unknown): boolean {
  if (err instanceof ZodError) return false;
  if (err instanceof TypeError) return false;
  if (err instanceof RateLimitError) return true;
  return true;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = config.MAX_RETRIES,
  delayMs = config.RETRY_DELAY_MS,
  isRetryable: (err: unknown) => boolean = DEFAULT_IS_RETRYABLE,
  maxDelayMs = 30_000
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Check backoff before each attempt
      if (isThrottled()) {
        throw new RateLimitError(30);
      }
      return await fn();
    } catch (err) {
      // Detect 429 from Horizon/Soroban responses
      if (err instanceof Error && err.message.includes("429")) {
        handleRateLimitResponse(null);
        lastErr = new RateLimitError(30);
      } else {
        lastErr = err;
      }

      if (!isRetryable(err) && !(err instanceof RateLimitError)) {
        throw err;
      }

      logger.warn("Retry attempt failed", {
        attempt,
        maxRetries: retries,
        error: (err as Error).message,
      });

      if (attempt < retries) {
        const exponential = delayMs * Math.pow(2, attempt - 1);
        const capped = Math.min(exponential, maxDelayMs);
        const jitter = Math.random() * 0.2 * capped;
        await new Promise((r) => setTimeout(r, capped + jitter));
      }
    }
  }
  throw new StellarRPCError(
    "RPC call failed after  attempt: ",
    lastErr
  );
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id));
}

export const horizonServer = new Horizon.Server(config.HORIZON_URL, {
  allowHttp: config.STELLAR_NETWORK === "testnet" || config.STELLAR_NETWORK === "futurenet",
});

export async function loadAccount(publicKey: string) {
  return withBackoffGuard(() =>
    withTimeout(
      withRetry(() => horizonServer.loadAccount(publicKey), config.MAX_RETRIES, config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE),
      config.RPC_TIMEOUT_MS
    )
  );
}

export async function submitTransaction(tx: Transaction | FeeBumpTransaction) {
  validateXDR(tx.toEnvelope().toXDR("base64"));

  return withBackoffGuard(() =>
    withRetry(() => {
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
    })
  );
}

export const sorobanServer = new rpc.Server(config.SOROBAN_RPC_URL, {
  allowHttp: config.STELLAR_NETWORK === "testnet" || config.STELLAR_NETWORK === "futurenet",
});

export async function simulateSorobanTx(tx: Transaction) {
  return withBackoffGuard(() =>
    withTimeout(
      withRetry(() => sorobanServer.simulateTransaction(tx), config.MAX_RETRIES, config.RETRY_DELAY_MS, DEFAULT_IS_RETRYABLE),
      config.RPC_TIMEOUT_MS
    )
  );
}

export async function prepareSorobanTx(tx: Transaction): Promise<Transaction> {
  const simResult = await simulateSorobanTx(tx);
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error("Soroban simulation failed: ");
  }
  return rpc.assembleTransaction(tx, simResult).build();
}
