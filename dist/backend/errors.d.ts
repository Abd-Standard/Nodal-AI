/**
 * backend/errors.ts
 *
 * Typed error classes for tool failures and system errors.
 * Allows callers to programmatically distinguish between error types
 * rather than relying on brittle string matching.
 */
export declare enum ErrorType {
    InsufficientFunds = "INSUFFICIENT_FUNDS",
    NetworkTimeout = "NETWORK_TIMEOUT",
    ValidationError = "VALIDATION_ERROR",
    RateLimitError = "RATE_LIMIT_ERROR",
    UnauthorizedError = "UNAUTHORIZED_ERROR",
    ContractError = "CONTRACT_ERROR",
    TransactionFailure = "TRANSACTION_FAILURE",
    ConfigError = "CONFIG_ERROR",
    UnknownError = "UNKNOWN_ERROR"
}
export declare class StructuredError extends Error {
    readonly errorType: ErrorType;
    readonly cause?: unknown;
    constructor(message: string, errorType: ErrorType, cause?: unknown);
}
export declare class InsufficientFundsError extends StructuredError {
    constructor(message: string, cause?: unknown);
}
export declare class NetworkTimeoutError extends StructuredError {
    constructor(message: string, cause?: unknown);
}
export declare class ValidationError extends StructuredError {
    constructor(message: string, cause?: unknown);
}
export declare class RateLimitError extends StructuredError {
    readonly retryAfterSeconds?: number | undefined;
    constructor(message: string, retryAfterSeconds?: number, cause?: unknown);
}
export declare class UnauthorizedError extends StructuredError {
    constructor(message: string, cause?: unknown);
}
export declare class ContractError extends StructuredError {
    readonly contractId?: string | undefined;
    constructor(message: string, contractId?: string, cause?: unknown);
}
export declare class TransactionFailureError extends StructuredError {
    readonly txHash?: string | undefined;
    constructor(message: string, txHash?: string, cause?: unknown);
}
export declare class ConfigError extends StructuredError {
    constructor(message: string, cause?: unknown);
}
declare function getErrorType(error: unknown): ErrorType;
export { getErrorType };
//# sourceMappingURL=errors.d.ts.map