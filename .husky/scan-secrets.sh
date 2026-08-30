#!/bin/sh
# ─── Secret scanner: pre-commit hook ─────────────────────────────────────────
# Scans staged changes for Stellar secret keys (S[A-Z2-7]{55}).
# Prevents accidental commits of hardcoded keypairs.
#
# Known test keys used in test files are allowlisted under ALLOWED_KEYS.
# Add new test keys there when they are intentionally required.
# ──────────────────────────────────────────────────────────────────────────────

SELF=$(basename "$0")
ALLOWED_KEYS="process.env.AGENT_SECRET_KEY SDPFZL3WZFXHQVLZX3TUZ5VXYYNZGLHC5BKWBHXMB5E6D64B2YJJFHF5 SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73 SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X"

# Collect staged diff lines that contain a Stellar secret key pattern
MATCHES=$(git diff --cached --diff-filter=ACM --no-color -U0 2>/dev/null | \
  grep -n '^+.*S[A-Z2-7]\{55\}' | \
  grep -v '^\+\+\+' || true)

# If no matches found, exit cleanly
if [ -z "$MATCHES" ]; then
  exit 0
fi

# Check each match against the allowlist
HAS_ERROR=0
ERROR_LINES=""

IFS='
'
for match in $MATCHES; do
  line_num=$(echo "$match" | cut -d: -f1)
  line=$(echo "$match" | cut -d: -f2-)
  stripped=$(echo "$line" | sed 's/^+//')

  allowed=0
  # IFS is newline for the outer $MATCHES loop; restore default splitting
  # so $ALLOWED_KEYS iterates per-key instead of as one combined string.
  IFS=' '
  for key in $ALLOWED_KEYS; do
    case "$stripped" in
      *"$key"*) allowed=1; break ;;
    esac
  done
  IFS='
'

  if [ "$allowed" -eq 0 ]; then
    HAS_ERROR=1
    ERROR_LINES="${ERROR_LINES}  (line ${line_num}) ${stripped}
"
  fi
done
unset IFS

if [ "$HAS_ERROR" -eq 1 ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════════════╗"
  echo "║  SECURITY: Stellar secret key detected in staged changes       ║"
  echo "╚══════════════════════════════════════════════════════════════════╝"
  printf "%s" "$ERROR_LINES"
  echo ""
  echo "Remove the hardcoded secret or add it to ALLOWED_KEYS in"
  echo ".husky/scan-secrets.sh if it is an intentional test key."
  exit 1
fi
