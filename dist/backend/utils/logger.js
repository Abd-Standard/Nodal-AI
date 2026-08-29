"use strict";
/**
 * backend/utils/logger.ts
 * Singleton Pino logger. Import `logger` or use `createLogger` for component-scoped child loggers.
 * Set LOG_LEVEL env var to control verbosity (default: "info").
 * Set NODE_ENV=production to emit raw JSON; otherwise prettified output is used.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.createLogger = createLogger;
exports.generateCorrelationId = generateCorrelationId;
const pino_1 = __importDefault(require("pino"));
const isDev = process.env.NODE_ENV !== "production";
exports.logger = (0, pino_1.default)({
    level: process.env.LOG_LEVEL ?? "info",
    ...(isDev && {
        transport: {
            target: "pino-pretty",
            options: { colorize: true },
        },
    }),
});
/**
 * Returns a child logger pre-tagged with `component` and an optional `correlationId`.
 * Use this at the top of each module: `const log = createLogger("orchestrator")`.
 */
function createLogger(component, correlationId) {
    return exports.logger.child({
        component,
        ...(correlationId !== undefined && { correlationId }),
    });
}
/** Generates a UUID v4 to correlate all log entries for a single transaction flow. */
function generateCorrelationId() {
    return crypto.randomUUID();
}
//# sourceMappingURL=logger.js.map