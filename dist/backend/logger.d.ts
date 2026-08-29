/**
 * backend/logger.ts
 * Structured JSON logger for production observability.
 *
 * Log levels (ordered by verbosity):
 *   debug < info < warn < error
 *
 * LOG_LEVEL env var controls verbosity; defaults to "info".
 * All logs are JSON objects with standardized fields for easy parsing.
 * Secrets are redacted to prevent leakage into logs.
 */
/**
 * Redact secrets from an object or string.
 * Replaces Stellar secret keys (S...) with [REDACTED].
 *
 * @param value - The value to redact
 * @returns The redacted value
 */
export declare function redactSecrets(value: unknown): unknown;
export declare const logger: {
    debug: (message: string, meta?: Record<string, unknown>) => void;
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
};
//# sourceMappingURL=logger.d.ts.map