"use strict";
/**
 * tests/errors.test.ts
 *
 * Tests for structured error types in backend/errors.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const errors_1 = require("../backend/errors");
(0, vitest_1.describe)("Structured Error Types", () => {
    (0, vitest_1.it)("creates an InsufficientFundsError with correct type", () => {
        const error = new errors_1.InsufficientFundsError("Not enough funds");
        (0, vitest_1.expect)(error).toBeInstanceOf(errors_1.StructuredError);
        (0, vitest_1.expect)(error.errorType).toBe(errors_1.ErrorType.InsufficientFunds);
        (0, vitest_1.expect)(error.message).toBe("Not enough funds");
    });
    (0, vitest_1.it)("creates a NetworkTimeoutError with correct type", () => {
        const error = new errors_1.NetworkTimeoutError("Request timed out");
        (0, vitest_1.expect)(error).toBeInstanceOf(errors_1.StructuredError);
        (0, vitest_1.expect)(error.errorType).toBe(errors_1.ErrorType.NetworkTimeout);
        (0, vitest_1.expect)(error.message).toBe("Request timed out");
    });
    (0, vitest_1.it)("creates a ValidationError with correct type", () => {
        const error = new errors_1.ValidationError("Invalid input");
        (0, vitest_1.expect)(error).toBeInstanceOf(errors_1.StructuredError);
        (0, vitest_1.expect)(error.errorType).toBe(errors_1.ErrorType.ValidationError);
        (0, vitest_1.expect)(error.message).toBe("Invalid input");
    });
    (0, vitest_1.it)("creates a RateLimitError with retryAfterSeconds", () => {
        const error = new errors_1.RateLimitError("Rate limited", 30);
        (0, vitest_1.expect)(error).toBeInstanceOf(errors_1.StructuredError);
        (0, vitest_1.expect)(error.errorType).toBe(errors_1.ErrorType.RateLimitError);
        (0, vitest_1.expect)(error.retryAfterSeconds).toBe(30);
        (0, vitest_1.expect)(error.message).toBe("Rate limited");
    });
    (0, vitest_1.it)("creates an UnauthorizedError with correct type", () => {
        const error = new errors_1.UnauthorizedError("Access denied");
        (0, vitest_1.expect)(error).toBeInstanceOf(errors_1.StructuredError);
        (0, vitest_1.expect)(error.errorType).toBe(errors_1.ErrorType.UnauthorizedError);
        (0, vitest_1.expect)(error.message).toBe("Access denied");
    });
    (0, vitest_1.it)("creates a ContractError with contractId", () => {
        const contractId = "CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH";
        const error = new errors_1.ContractError("Contract execution failed", contractId);
        (0, vitest_1.expect)(error).toBeInstanceOf(errors_1.StructuredError);
        (0, vitest_1.expect)(error.errorType).toBe(errors_1.ErrorType.ContractError);
        (0, vitest_1.expect)(error.contractId).toBe(contractId);
    });
    (0, vitest_1.it)("creates a TransactionFailureError with txHash", () => {
        const txHash = "abcd1234";
        const error = new errors_1.TransactionFailureError("Transaction failed", txHash);
        (0, vitest_1.expect)(error).toBeInstanceOf(errors_1.StructuredError);
        (0, vitest_1.expect)(error.errorType).toBe(errors_1.ErrorType.TransactionFailure);
        (0, vitest_1.expect)(error.txHash).toBe(txHash);
    });
    (0, vitest_1.it)("creates a ConfigError with correct type", () => {
        const error = new errors_1.ConfigError("Missing required config");
        (0, vitest_1.expect)(error).toBeInstanceOf(errors_1.StructuredError);
        (0, vitest_1.expect)(error.errorType).toBe(errors_1.ErrorType.ConfigError);
    });
    (0, vitest_1.it)("preserves cause when provided", () => {
        const cause = new Error("Original error");
        const error = new errors_1.InsufficientFundsError("Wrapped error", cause);
        (0, vitest_1.expect)(error.cause).toBe(cause);
    });
    (0, vitest_1.it)("getErrorType returns correct error type for StructuredError", () => {
        const error = new errors_1.ValidationError("test");
        (0, vitest_1.expect)((0, errors_1.getErrorType)(error)).toBe(errors_1.ErrorType.ValidationError);
    });
    (0, vitest_1.it)("getErrorType returns UNKNOWN_ERROR for non-StructuredError", () => {
        const error = new Error("generic error");
        (0, vitest_1.expect)((0, errors_1.getErrorType)(error)).toBe(errors_1.ErrorType.UnknownError);
    });
    (0, vitest_1.it)("getErrorType returns UNKNOWN_ERROR for non-Error objects", () => {
        (0, vitest_1.expect)((0, errors_1.getErrorType)("string error")).toBe(errors_1.ErrorType.UnknownError);
        (0, vitest_1.expect)((0, errors_1.getErrorType)(null)).toBe(errors_1.ErrorType.UnknownError);
        (0, vitest_1.expect)((0, errors_1.getErrorType)(undefined)).toBe(errors_1.ErrorType.UnknownError);
    });
});
//# sourceMappingURL=errors.test.js.map