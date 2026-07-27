/**
 * backend/rpc_client.ts
 * Thin wrapper around Horizon + Soroban RPC with retry logic and rate-limit awareness.
 */
import { Horizon, rpc, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk";
import CircuitBreaker from "opossum";
export declare const RPC_BREAKER_OPTIONS: {
    errorThresholdPercentage: number;
    resetTimeout: number;
    timeout: number;
    volumeThreshold: number;
    rollingCountTimeout: number;
    rollingCountBuckets: number;
};
export declare function attachBreakerTelemetry<TArgs extends unknown[], TResult>(breaker: CircuitBreaker<TArgs, TResult>, name: string): CircuitBreaker<TArgs, TResult>;
export declare function createRpcBreaker<TArgs extends unknown[], TResult>(name: string, action: (...args: TArgs) => Promise<TResult>): CircuitBreaker<TArgs, TResult>;
export declare function resolveNetworkPassphrase(network: string): string;
export declare class TimeoutError extends Error {
    constructor(ms: number);
}
export declare class StellarRPCError extends Error {
    readonly cause: unknown;
    constructor(message: string, cause: unknown);
}
export declare class RateLimitError extends Error {
    readonly retryAfterSeconds: number;
    constructor(retryAfterSeconds: number);
}
export declare function DEFAULT_IS_RETRYABLE(err: unknown): boolean;
export declare function withRetry<T>(fn: () => Promise<T>, retries?: number, delayMs?: number, isRetryable?: (err: unknown) => boolean, maxDelayMs?: number): Promise<T>;
export declare function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
export declare const horizonServer: Horizon.Server;
export declare function loadAccount(publicKey: string): Promise<Horizon.AccountResponse>;
export declare function submitTransaction(tx: Transaction | FeeBumpTransaction): Promise<Horizon.HorizonApi.SubmitTransactionResponse>;
export declare const sorobanServer: rpc.Server;
export declare function simulateSorobanTx(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
export declare function prepareSorobanTx(tx: Transaction): Promise<Transaction>;
//# sourceMappingURL=rpc_client.d.ts.map