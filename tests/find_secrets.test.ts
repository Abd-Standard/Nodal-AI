/**
 * tests/find_secrets.test.ts
 * Unit tests for the detection regex and allowlist parsing in scripts/find_secrets.js.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const { getAllowedKeys, findSecretKeys } = require('../scripts/find_secrets.js');

// Synthetic secret-shaped values, built at runtime to avoid tripping the pre-commit scanner.
const ALLOWED = 'S' + 'A'.repeat(55);
const BLOCKED = 'S' + 'B'.repeat(55);

describe('find_secrets', () => {
  it('reads the allowlist file, skipping comments and blank lines', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'find-secrets-')), 'allowed.txt');
    writeFileSync(file, `# comment\n${ALLOWED}\n\nprocess.env.AGENT_SECRET_KEY\n`);
    expect(getAllowedKeys(file)).toEqual([ALLOWED, 'process.env.AGENT_SECRET_KEY']);
  });

  it('returns an empty allowlist when the file is missing', () => {
    expect(getAllowedKeys(join(tmpdir(), 'does-not-exist.txt'))).toEqual([]);
  });

  it('detects standalone keys, both allowlisted and blocked', () => {
    const allowed = [ALLOWED];
    const keys = findSecretKeys(`const a = "${ALLOWED}"; const b = '${BLOCKED}';`);
    expect(keys).toEqual([ALLOWED, BLOCKED]);
    expect(keys.filter((k: string) => !allowed.includes(k))).toEqual([BLOCKED]);
  });

  it('does not match a 56-char substring inside a longer base32 token', () => {
    expect(findSecretKeys(`X${BLOCKED}`)).toEqual([]);
    expect(findSecretKeys(`${BLOCKED}2`)).toEqual([]);
    expect(findSecretKeys(BLOCKED + 'AAAA')).toEqual([]);
  });
});
