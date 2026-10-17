const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ALLOWLIST_FILE = path.join(__dirname, '..', '.husky', 'allowed-secrets.txt');

// Require a non-base32 boundary on both sides so a 56-char substring embedded
// inside a longer base32-looking token is not reported as a secret key.
const SECRET_KEY_REGEX = /(?<![A-Z2-7])S[A-Z2-7]{55}(?![A-Z2-7])/g;
const SECRET_KEY_GIT_GREP = '(^|[^A-Z2-7])S[A-Z2-7]{55}([^A-Z2-7]|$)';

function getAllowedKeys(file = ALLOWLIST_FILE) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch (e) {
    return [];
  }
}

function findSecretKeys(text) {
  return Array.from(text.matchAll(SECRET_KEY_REGEX)).map((m) => m[0]);
}

function main() {
  const allowed = getAllowedKeys();
  console.log('Allowed keys:', allowed.join(' '));

  let out = '';
  try {
    out = execSync(`git grep -nE "${SECRET_KEY_GIT_GREP}" -- "*"`, { encoding: 'utf8' });
  } catch (e) {
    out = e.stdout || '';
  }
  if (!out.trim()) {
    console.log('\nNo Stellar secret-like strings found in the repository.');
    process.exit(0);
  }

  const lines = out.split(/\r?\n/).filter(Boolean);
  let found = [];
  for (const line of lines) {
    const parts = line.split(':');
    const file = parts.shift();
    const lineno = parts.shift();
    const text = parts.join(':');
    const matches = findSecretKeys(text);
    for (const key of matches) {
      const isAllowed = allowed.some(a => a === key);
      found.push({ file, lineno, key, text: text.trim(), allowed: isAllowed });
    }
  }

  if (found.length === 0) {
    console.log('\nNo matches after filtering.');
    process.exit(0);
  }

  console.log('\nDetected Stellar-like secrets:');
  for (const f of found) {
    console.log(`${f.file}:${f.lineno}  ${f.allowed ? '[ALLOWLISTED]' : '[BLOCKED]   '} ${f.key}`);
  }

  const blocked = found.filter(f => !f.allowed);
  if (blocked.length > 0) {
    console.log('\nBlocked occurrences (not in .husky/allowed-secrets.txt):');
    for (const b of blocked) console.log(` - ${b.file}:${b.lineno} -> ${b.key}`);
    process.exit(2);
  } else {
    console.log('\nAll found secrets are allowlisted.');
    process.exit(0);
  }
}

module.exports = { getAllowedKeys, findSecretKeys };

if (require.main === module) main();
