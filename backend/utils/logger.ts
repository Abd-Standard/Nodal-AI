/**
 * backend/utils/logger.ts
 * Singleton Pino logger. Import `logger` or use `createLogger` for component-scoped child loggers.
 * Set LOG_LEVEL env var to control verbosity (default: "info").
 * Set NODE_ENV=production to emit raw JSON; otherwise prettified output is used.
 */

import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

// Transaction memos (e.g. the nonce slices X402PaymentTool writes) can carry
// caller-supplied, potentially user-identifiable strings, so they're stripped
// from structured log output regardless of nesting depth.
export const REDACT_PATHS = ['*.memo', 'payload.memo', 'data.memo'];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: REDACT_PATHS,
    remove: true,
  },
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
});

/**
 * Returns a child logger pre-tagged with `component` and an optional `correlationId`.
 * Use this at the top of each module: `const log = createLogger("orchestrator")`.
 */
export function createLogger(component: string, correlationId?: string) {
  return logger.child({
    component,
    ...(correlationId !== undefined && { correlationId }),
  });
}

/** Generates a UUID v4 to correlate all log entries for a single transaction flow. */
export function generateCorrelationId(): string {
  return crypto.randomUUID();
}
