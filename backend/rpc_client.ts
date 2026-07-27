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
import CircuitBreaker from "opossum";
import { ZodError } from "zod";
import { config } from "./config";
import { logger } from "./logger";
import { validateXDR } from "./types/xdr";
import { createLogger } from "./utils/logger";
import { isThrottled, handleRateLimitResponse, withBackoffGuard } from "./network";
import { withSpan } from "./telemetry";

const log = createLogger("rpc-client");
// Exported so the breaker's behaviour can be asserted against the real
// thresholds rather than a copy that silently drifts from them (#244).
export const RPC_BREAKER_OPTIONS = {
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  timeout: 10_000,
  volumeThreshold: 5,
  rollingCountTimeout: 30_000,
  rollingCountBuckets: 10,
};

class RpcServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcServiceUnavailableError";
  }
}

type HorizonAccount = Awaited<ReturnType<Horizon.Server["loadAccount"]>>;
type HorizonSubmitResult = Awaited<ReturnType<Horizon.Server["submitTransaction"]>>;
type SorobanSimulationResult = Awaited<ReturnType<rpc.Server["simulateTransaction"]>>;

const accountCache = new Map<string, HorizonAccount>();

export function attachBreakerTelemetry<TArgs extends unknown[], TResult>(
  breaker: CircuitBreaker<TArgs, TResult>,
  name: string
): CircuitBreaker<TArgs, TResult> {
  breaker.on("open", () => {
    log.warn({
      circuit: name,
      failures: breaker.stats.failures,
      successes: breaker.stats.successes,
      timeout: RPC_BREAKER_OPTIONS.timeout,
      resetTimeout: RPC_BREAKER_OPTIONS.resetTimeout,
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

export function createRpcBreaker<TArgs extends unknown[], TResult>(
  name: string,
  action: (...args: TArgs) => Promise<TResult>
): CircuitBreaker<TArgs, TResult> {
  return attachBreakerTelemetry(
    new CircuitBreaker(action, {
      ...RPC_BREAKER_OPTIONS,
      name,
    }),
    name
  );
}

export function resolveNetworkPassphrase(network: string): string {
  if (network === "mainnet") return Networks.PUBLIC;
  if (network === "futurenet") return Networks.FUTURENET;
  if (network === "testnet") return Networks.TESTNET;
  throw new Error(`Unsupported network: ${network}`);
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Transaction Timeout: request did not complete within ${ms}ms`);
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
    super(`Rate limited. Retry after ${retryAfterSeconds} seconds`);
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
  return withSpan(
    "withRetry",
    async () => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= retries; attempt++) {
        logger.debug(`[withRetry] Attempt ${attempt}/${retries}: calling...`);
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
      const lastErrorMessage =
        lastErr instanceof Error ? lastErr.message : String(lastErr ?? "unknown error");
      throw new StellarRPCError(
        `RPC call failed after ${retries} attempt(s): ${lastErrorMessage}`,
        lastErr
      );
    },
    { "rpc.maxRetries": retries }
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
