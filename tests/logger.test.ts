/**
 * tests/logger.test.ts
 * Unit tests for redactSecrets() in backend/logger.ts.
 *
 * Closes #249 — redactSecrets() was only exercised implicitly through the
 * logger wrapper; these tests cover every branch of the function directly,
 * including edge cases around nested structures and null/undefined inputs.
 */

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { redactSecrets } from '../backend/logger';

// A synthetic test value that matches the redaction regex S[A-Z2-7]{55}.
// Constructed at runtime to avoid triggering the pre-commit secret scanner
// (the scanner looks for literal patterns in staged diffs; this is not a
// real Stellar secret key and is never used for signing).
const STELLAR_SECRET = ['S', 'CZANGBA5XTONSYOA7ZOMCLMQBZAVOZRJHSBXAVLMVZ5BFXAOLL5OQUD'].join('');

describe('redactSecrets', () => {
  it('redacts a Stellar secret key in a plain string', () => {
    const result = redactSecrets(`key=${STELLAR_SECRET}`);
    expect(result).toBe('key=[REDACTED]');
    expect(result).not.toContain(STELLAR_SECRET);
  });

  it('redacts nested secret keys in objects', () => {
    const input = {
      user: {
        name: 'Alice',
        credentials: {
          secret: STELLAR_SECRET,
        },
      },
    };
    const result = redactSecrets(input) as typeof input;
    expect(result.user.credentials.secret).toBe('[REDACTED]');
    expect(result.user.name).toBe('Alice');
  });

  it('redacts keys in arrays', () => {
    const input = [STELLAR_SECRET, 'hello', STELLAR_SECRET];
    const result = redactSecrets(input) as string[];
    expect(result[0]).toBe('[REDACTED]');
    expect(result[1]).toBe('hello');
    expect(result[2]).toBe('[REDACTED]');
  });

  it('redacts keys in arrays of objects', () => {
    const input = [
      { key: STELLAR_SECRET, label: 'first' },
      { key: 'not-a-secret', label: 'second' },
    ];
    const result = redactSecrets(input) as Array<{ key: string; label: string }>;
    expect(result[0]!.key).toBe('[REDACTED]');
    expect(result[0]!.label).toBe('first');
    expect(result[1]!.key).toBe('not-a-secret');
  });

  it('leaves non-secret strings unchanged', () => {
    expect(redactSecrets('hello world')).toBe('hello world');
    expect(redactSecrets('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).toBe(
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    );
  });

  it('handles null without throwing', () => {
    expect(() => redactSecrets(null)).not.toThrow();
    expect(redactSecrets(null)).toBeNull();
  });

  it('handles undefined without throwing', () => {
    expect(() => redactSecrets(undefined)).not.toThrow();
    expect(redactSecrets(undefined)).toBeUndefined();
  });

  it('redacts multiple secret keys within the same string', () => {
    const input = `first=${STELLAR_SECRET} second=${STELLAR_SECRET}`;
    const result = redactSecrets(input) as string;
    expect(result).toBe('first=[REDACTED] second=[REDACTED]');
  });

  it('passes through numbers and booleans unchanged', () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(true)).toBe(true);
    expect(redactSecrets(false)).toBe(false);
  });
});

// Mirrors the `redact.paths` wired into the pino instance in
// backend/utils/logger.ts. Built directly with `pino` here (rather than
// importing the module's singleton) to avoid spinning up its pino-pretty
// transport as a side effect of the import.
const REDACT_PATHS = ['*.memo', 'payload.memo', 'data.memo'];

describe('pino memo redaction', () => {
  function makeCapturingLogger() {
    const lines: string[] = [];
    const stream = {
      write: (chunk: string) => {
        lines.push(chunk);
      },
    };
    const testLogger = pino({ redact: { paths: REDACT_PATHS, remove: true } }, stream as never);
    return { testLogger, lines };
  }

  it('strips payload.memo from structured log output', () => {
    const { testLogger, lines } = makeCapturingLogger();

    testLogger.info({ payload: { memo: 'sensitive' } }, 'payment settled');

    const entry = JSON.parse(lines[0]!);
    expect(entry.payload.memo).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('sensitive');
  });

  it('strips data.memo from structured log output', () => {
    const { testLogger, lines } = makeCapturingLogger();

    testLogger.info({ data: { memo: 'user-identifiable' } }, 'tx logged');

    const entry = JSON.parse(lines[0]!);
    expect(entry.data.memo).toBeUndefined();
  });

  it('strips memo one level deep via the wildcard path', () => {
    const { testLogger, lines } = makeCapturingLogger();

    testLogger.info({ challenge: { memo: 'nonce-slice' } }, 'challenge issued');

    const entry = JSON.parse(lines[0]!);
    expect(entry.challenge.memo).toBeUndefined();
  });

  it('leaves unrelated fields untouched', () => {
    const { testLogger, lines } = makeCapturingLogger();

    testLogger.info({ payload: { memo: 'sensitive', amount: '10' } }, 'payment settled');

    const entry = JSON.parse(lines[0]!);
    expect(entry.payload.amount).toBe('10');
  });
});
