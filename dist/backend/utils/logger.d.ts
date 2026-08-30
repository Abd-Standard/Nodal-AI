/**
 * backend/utils/logger.ts
 * Singleton Pino logger. Import `logger` or use `createLogger` for component-scoped child loggers.
 * Set LOG_LEVEL env var to control verbosity (default: "info").
 * Set NODE_ENV=production to emit raw JSON; otherwise prettified output is used.
 */
import pino from "pino";
export declare const logger: pino.Logger<never, boolean>;
/**
 * Returns a child logger pre-tagged with `component` and an optional `correlationId`.
 * Use this at the top of each module: `const log = createLogger("orchestrator")`.
 */
export declare function createLogger(component: string, correlationId?: string): pino.Logger<never, boolean>;
/** Generates a UUID v4 to correlate all log entries for a single transaction flow. */
export declare function generateCorrelationId(): string;
//# sourceMappingURL=logger.d.ts.map