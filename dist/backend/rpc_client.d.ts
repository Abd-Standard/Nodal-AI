/**
 * backend/rpc_client.ts
 * Thin wrapper around Horizon + Soroban RPC with retry logic.
 * All network calls route through here — centralised observability point.
 */
import { Horizon, rpc, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
/**
 * Map a STELLAR_NETWORK string to its canonical network passphrase.
 * Throws for any unrecognised network string so callers fail fast rather than
 * silently defaulting to the wrong passphrase.
 */
export declare function resolveNetworkPassphrase(network: string): string;
export declare class TimeoutError extends Error {
    constructor(ms: number);
}
/** Wraps the final error thrown after all retry attempts are exhausted. */
export declare class StellarRPCError extends Error {
    readonly cause: unknown;
    constructor(message: string, cause: unknown);
}
/**
 * Returns false for deterministic failures (ZodError, TypeError) that will
 * never succeed on retry, true for transient errors worth retrying.
 */
export declare function DEFAULT_IS_RETRYABLE(err: unknown): boolean;
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
export declare function withRetry<T>(fn: () => Promise<T>, retries?: number, delayMs?: number, isRetryable?: (err: unknown) => boolean, maxDelayMs?: number): Promise<T>;
/**
 * Wraps a promise in a race against a timeout.
 * Throws TimeoutError if the promise does not resolve within `ms` milliseconds.
 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
/**
 * Horizon server instance client.
 *
 * @remarks
 * The `allowHttp` configuration flag uses an explicit allowlist: only testnet and futurenet permit HTTP.
 * On mainnet, this client strictly enforces secure HTTPS connections to protect transaction transmission.
 * This prevents misconfiguration (e.g., "Mainnet" with capital M) from enabling plaintext connections.
 */
export declare const horizonServer: Horizon.Server;
/**
 * Loads account details from the Horizon network for a given public key.
 *
 * @param publicKey - The 56-character Stellar public key (G-address) of the account.
 * @returns A promise resolving to the Horizon account details.
 * @throws An error if the account cannot be loaded after retries.
 */
export declare function loadAccount(publicKey: string): Promise<Horizon.AccountResponse>;
/**
 * Submits a signed transaction to the Stellar network via Horizon.
 *
 * @param tx - The Transaction or FeeBumpTransaction to submit.
 * @returns A promise resolving to the Horizon transaction submission response.
 * @throws A TimeoutError if submission does not complete within 30 seconds.
 * @throws An error if the transaction payload is rejected or submission fails.
 */
export declare function submitTransaction(tx: Transaction | FeeBumpTransaction): Promise<Horizon.HorizonApi.SubmitTransactionResponse>;
/**
 * Soroban RPC server instance client.
 *
 * @remarks
 * The `allowHttp` flag uses an explicit allowlist: only testnet and futurenet permit HTTP.
 * On mainnet, HTTPS is enforced. Caution: sending mainnet transaction payloads or queries over plain HTTP
 * exposes sensitive network calls to eavesdropping or tampering.
 */
export declare const sorobanServer: rpc.Server;
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
export declare function simulateSorobanTx(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
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
export declare function prepareSorobanTx(tx: Transaction): Promise<Transaction>;
//# sourceMappingURL=rpc_client.d.ts.map