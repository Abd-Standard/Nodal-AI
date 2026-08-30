"use strict";
/**
 * backend/errors.ts
 *
 * Typed error classes for tool failures and system errors.
 * Allows callers to programmatically distinguish between error types
 * rather than relying on brittle string matching.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigError = exports.TransactionFailureError = exports.ContractError = exports.UnauthorizedError = exports.RateLimitError = exports.ValidationError = exports.NetworkTimeoutError = exports.InsufficientFundsError = exports.StructuredError = exports.ErrorType = void 0;
exports.getErrorType = getErrorType;
var ErrorType;
(function (ErrorType) {
    ErrorType["InsufficientFunds"] = "INSUFFICIENT_FUNDS";
    ErrorType["NetworkTimeout"] = "NETWORK_TIMEOUT";
    ErrorType["ValidationError"] = "VALIDATION_ERROR";
    ErrorType["RateLimitError"] = "RATE_LIMIT_ERROR";
    ErrorType["UnauthorizedError"] = "UNAUTHORIZED_ERROR";
    ErrorType["ContractError"] = "CONTRACT_ERROR";
    ErrorType["TransactionFailure"] = "TRANSACTION_FAILURE";
    ErrorType["ConfigError"] = "CONFIG_ERROR";
    ErrorType["UnknownError"] = "UNKNOWN_ERROR";
})(ErrorType || (exports.ErrorType = ErrorType = {}));
class StructuredError extends Error {
    errorType;
    cause;
    constructor(message, errorType, cause) {
        super(message);
        this.name = this.constructor.name;
        this.errorType = errorType;
        this.cause = cause;
        Object.setPrototypeOf(this, StructuredError.prototype);
    }
}
exports.StructuredError = StructuredError;
class InsufficientFundsError extends StructuredError {
    constructor(message, cause) {
        super(message, ErrorType.InsufficientFunds, cause);
        Object.setPrototypeOf(this, InsufficientFundsError.prototype);
    }
}
exports.InsufficientFundsError = InsufficientFundsError;
class NetworkTimeoutError extends StructuredError {
    constructor(message, cause) {
        super(message, ErrorType.NetworkTimeout, cause);
        Object.setPrototypeOf(this, NetworkTimeoutError.prototype);
    }
}
exports.NetworkTimeoutError = NetworkTimeoutError;
class ValidationError extends StructuredError {
    constructor(message, cause) {
        super(message, ErrorType.ValidationError, cause);
        Object.setPrototypeOf(this, ValidationError.prototype);
    }
}
exports.ValidationError = ValidationError;
class RateLimitError extends StructuredError {
    retryAfterSeconds;
    constructor(message, retryAfterSeconds, cause) {
        super(message, ErrorType.RateLimitError, cause);
        this.retryAfterSeconds = retryAfterSeconds;
        Object.setPrototypeOf(this, RateLimitError.prototype);
    }
}
exports.RateLimitError = RateLimitError;
class UnauthorizedError extends StructuredError {
    constructor(message, cause) {
        super(message, ErrorType.UnauthorizedError, cause);
        Object.setPrototypeOf(this, UnauthorizedError.prototype);
    }
}
exports.UnauthorizedError = UnauthorizedError;
class ContractError extends StructuredError {
    contractId;
    constructor(message, contractId, cause) {
        super(message, ErrorType.ContractError, cause);
        this.contractId = contractId;
        Object.setPrototypeOf(this, ContractError.prototype);
    }
}
exports.ContractError = ContractError;
class TransactionFailureError extends StructuredError {
    txHash;
    constructor(message, txHash, cause) {
        super(message, ErrorType.TransactionFailure, cause);
        this.txHash = txHash;
        Object.setPrototypeOf(this, TransactionFailureError.prototype);
    }
}
exports.TransactionFailureError = TransactionFailureError;
class ConfigError extends StructuredError {
    constructor(message, cause) {
        super(message, ErrorType.ConfigError, cause);
        Object.setPrototypeOf(this, ConfigError.prototype);
    }
}
exports.ConfigError = ConfigError;
function getErrorType(error) {
    if (error instanceof StructuredError) {
        return error.errorType;
    }
    return ErrorType.UnknownError;
}
//# sourceMappingURL=errors.js.map