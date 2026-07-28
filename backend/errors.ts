/**
 * backend/errors.ts
 *
 * Typed error classes for tool failures and system errors.
 * Allows callers to programmatically distinguish between error types
 * rather than relying on brittle string matching.
 */

export enum ErrorType {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  NetworkTimeout = "NETWORK_TIMEOUT",
  ValidationError = "VALIDATION_ERROR",
  RateLimitError = "RATE_LIMIT_ERROR",
  UnauthorizedError = "UNAUTHORIZED_ERROR",
  ContractError = "CONTRACT_ERROR",
  TransactionFailure = "TRANSACTION_FAILURE",
  ConfigError = "CONFIG_ERROR",
  UnknownError = "UNKNOWN_ERROR",
}

export class StructuredError extends Error {
  readonly errorType: ErrorType;
  readonly cause?: unknown;

  constructor(message: string, errorType: ErrorType, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.errorType = errorType;
    this.cause = cause;
    Object.setPrototypeOf(this, StructuredError.prototype);
  }
}

export class InsufficientFundsError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.InsufficientFunds, cause);
    Object.setPrototypeOf(this, InsufficientFundsError.prototype);
  }
}

export class NetworkTimeoutError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.NetworkTimeout, cause);
    Object.setPrototypeOf(this, NetworkTimeoutError.prototype);
  }
}

export class ValidationError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.ValidationError, cause);
    Object.setPrototypeOf(this, ValidationError.prototype);
  }
}

export class RateLimitError extends StructuredError {
  readonly retryAfterSeconds?: number | undefined;

  constructor(message: string, retryAfterSeconds?: number, cause?: unknown) {
    super(message, ErrorType.RateLimitError, cause);
    this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }
}

export class UnauthorizedError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.UnauthorizedError, cause);
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

export class ContractError extends StructuredError {
  readonly contractId?: string | undefined;

  constructor(message: string, contractId?: string, cause?: unknown) {
    super(message, ErrorType.ContractError, cause);
    this.contractId = contractId;
    Object.setPrototypeOf(this, ContractError.prototype);
  }
}

export class TransactionFailureError extends StructuredError {
  readonly txHash?: string | undefined;

  constructor(message: string, txHash?: string, cause?: unknown) {
    super(message, ErrorType.TransactionFailure, cause);
    this.txHash = txHash;
    Object.setPrototypeOf(this, TransactionFailureError.prototype);
  }
}

export class ConfigError extends StructuredError {
  constructor(message: string, cause?: unknown) {
    super(message, ErrorType.ConfigError, cause);
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

function getErrorType(error: unknown): ErrorType {
  if (error instanceof StructuredError) {
    return error.errorType;
  }
  return ErrorType.UnknownError;
}

export { getErrorType };
