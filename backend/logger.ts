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

import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// Log level definitions
const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

// Schema for LOG_LEVEL env var
const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error']).default('info');

const LOG_LEVEL = LogLevelSchema.parse(process.env.LOG_LEVEL);
const CURRENT_LEVEL = LOG_LEVELS[LOG_LEVEL];

/**
 * Redact secrets from an object or string.
 * Replaces Stellar secret keys (S...) with [REDACTED].
 *
 * @param value - The value to redact
 * @returns The redacted value
 */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/S[A-Z2-7]{55}/g, '[REDACTED]');
  }
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value !== null && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      redacted[key] = redactSecrets(val);
    }
    return redacted;
  }
  return value;
}

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Log a message at the specified level.
 *
 * @param level - The log level
 * @param message - The main log message
 * @param meta - Additional metadata to include
 */
function log(level: LogLevel, message: string, meta: Record<string, unknown> = {}): void {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) {
    return;
  }

  const entry: LogEntry = {
    level,
    timestamp: new Date().toISOString(),
    message: redactSecrets(message) as string,
    ...(redactSecrets(meta) as Record<string, unknown>),
  };

  const output = JSON.stringify(entry);

  if (level === 'error') {
    console.error(output);
  } else {
    console.log(output);
  }
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
};
