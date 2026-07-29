const fs = require('fs');
const { execSync } = require('child_process');

function getAllowedKeys() {
  try {
    const s = fs.readFileSync('.husky/scan-secrets.sh', 'utf8');
    const m = s.match(/ALLOWED_KEYS="([^"]+)"/);
    if (!m) return [];
    return m[1].split(/\s+/).filter(Boolean);
  } catch (e) {
    return [];
  }
}

const allowed = getAllowedKeys();
console.log('Allowed keys:', allowed.join(' '));

let out = '';
try {
  out = execSync('git grep -nE "S[A-Z2-7]{55}" -- "*"', { encoding: 'utf8' });
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
  const matches = Array.from(text.matchAll(/S[A-Z2-7]{55}/g)).map(m => m[0]);
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
  console.log('\nBlocked occurrences (not in ALLOWED_KEYS):');
  for (const b of blocked) console.log(` - ${b.file}:${b.lineno} -> ${b.key}`);
  process.exit(2);
} else {
  console.log('\nAll found secrets are allowlisted.');
  process.exit(0);
}
