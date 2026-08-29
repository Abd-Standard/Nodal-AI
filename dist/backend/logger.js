"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.redactSecrets = redactSecrets;
const zod_1 = require("zod");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
// Log level definitions
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};
// Schema for LOG_LEVEL env var
const LogLevelSchema = zod_1.z
    .enum(["debug", "info", "warn", "error"])
    .default("info");
const LOG_LEVEL = LogLevelSchema.parse(process.env.LOG_LEVEL);
const CURRENT_LEVEL = LOG_LEVELS[LOG_LEVEL];
/**
 * Redact secrets from an object or string.
 * Replaces Stellar secret keys (S...) with [REDACTED].
 *
 * @param value - The value to redact
 * @returns The redacted value
 */
function redactSecrets(value) {
    if (typeof value === "string") {
        return value.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
    }
    if (Array.isArray(value)) {
        return value.map(redactSecrets);
    }
    if (value !== null && typeof value === "object") {
        const redacted = {};
        for (const [key, val] of Object.entries(value)) {
            redacted[key] = redactSecrets(val);
        }
        return redacted;
    }
    return value;
}
/**
 * Log a message at the specified level.
 *
 * @param level - The log level
 * @param message - The main log message
 * @param meta - Additional metadata to include
 */
function log(level, message, meta = {}) {
    if (LOG_LEVELS[level] < CURRENT_LEVEL) {
        return;
    }
    const entry = {
        level,
        timestamp: new Date().toISOString(),
        message: redactSecrets(message),
        ...redactSecrets(meta),
    };
    const output = JSON.stringify(entry);
    if (level === "error") {
        console.error(output);
    }
    else {
        console.log(output);
    }
}
exports.logger = {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
};
//# sourceMappingURL=logger.js.map