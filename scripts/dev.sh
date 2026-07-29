#!/usr/bin/env bash
# =============================================================================
# scripts/dev.sh — Nodal AI unified stack runner
#
# Usage:
#   ./scripts/dev.sh up          # build + start full stack
#   ./scripts/dev.sh down        # stop and remove containers
#   ./scripts/dev.sh test        # start stack + run integration tests
#   ./scripts/dev.sh test:rust   # run Soroban contract tests locally
#   ./scripts/dev.sh logs        # tail all service logs
#   ./scripts/dev.sh clean       # remove containers, volumes, and images
#   ./scripts/dev.sh --dry-run   # check environment variables and exit
# =============================================================================

set -euo pipefail

COMPOSE="docker compose"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$PROJECT_ROOT"

# ── Helpers ───────────────────────────────────────────────────────────────────

log()  { echo "▶  $*"; }
warn() { echo "⚠️  $*" >&2; }
die()  { echo "❌ $*" >&2; exit 1; }

check_env() {
  local missing=()

  # Check each required variable
  if [[ -z "${AGENT_SECRET_KEY:-}" ]]; then
    missing+=("AGENT_SECRET_KEY")
  fi
  if [[ -z "${HORIZON_URL:-}" ]]; then
    missing+=("HORIZON_URL")
  fi
  if [[ -z "${SOROBAN_RPC_URL:-}" ]]; then
    missing+=("SOROBAN_RPC_URL")
  fi
  if [[ -z "${X402_ASSET_ISSUER:-}" ]]; then
    missing+=("X402_ASSET_ISSUER")
  fi

  # If any are missing, print error and exit 1
  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "❌ ERROR: Missing required environment variables:"
    for var in "${missing[@]}"; do
      echo "  - $var"
    done
    echo ""
    echo "Please set these variables in your .env file or environment."
    exit 1
  fi

  log "All required environment variables are set."
}

require_env() {
  [[ -f .env ]] || die ".env file not found. Copy ..env and fill in your values."
  # shellcheck disable=SC1091
  set -a; source .env; set +a
  check_env
}

# ── Commands ──────────────────────────────────────────────────────────────────

cmd_dry_run() {
  require_env
  log "Environment check passed!"
  exit 0
}

cmd_up() {
  require_env
  log "Building and starting Nodal AI stack..."
  $COMPOSE up --build -d
  log "Stack is running."
  log "  Horizon    : http://localhost:8000"
  log "  Soroban    : http://localhost:8001"
  log "  Agent      : http://localhost:3000"
  $COMPOSE logs -f
}

cmd_down() {
  log "Stopping stack..."
  $COMPOSE down
}

cmd_test() {
  require_env
  log "Starting stack + running integration tests..."
  $COMPOSE --profile test up --build --abort-on-container-exit --exit-code-from test-runner
}

cmd_test_rust() {
  log "Running Soroban contract tests (local Rust toolchain)..."
  cargo test --manifest-path contracts/escrow/Cargo.toml -- --nocapture
}

cmd_logs() {
  $COMPOSE logs -f
}

cmd_clean() {
  warn "This will remove all containers, volumes, and built images for this project."
  read -r -p "Continue? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { log "Aborted."; exit 0; }
  $COMPOSE down --volumes --rmi local
  log "Clean complete."
}

# ── Dispatch ──────────────────────────────────────────────────────────────────

case "${1:-up}" in
  --dry-run)  cmd_dry_run    ;;
  up)         cmd_up         ;;
  down)       cmd_down       ;;
  test)       cmd_test       ;;
  test:rust)  cmd_test_rust  ;;
  logs)       cmd_logs       ;;
  clean)      cmd_clean      ;;
  *)          die "Unknown command: $1. Use: --dry-run | up | down | test | test:rust | logs | clean" ;;
esac
