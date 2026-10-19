#!/usr/bin/env bash
#
# generate_escrow_bindings.sh — generate the official Stellar CLI TypeScript
# bindings for the escrow contract and check that the backend's typed client
# (backend/contracts/escrow/index.ts) covers exactly the same methods.
#
# Motivation: the backend invokes the escrow through `soroban_invoke` payloads.
# The typed client turns method-name typos and argument mismatches into
# compile errors, and this check turns a contract change that the client has
# not picked up (new/removed/renamed method) into a CI failure.
#
# Usage:
#   generate_escrow_bindings.sh [WASM_PATH] [OUT_DIR]
#
# Defaults:
#   WASM_PATH  contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm
#   OUT_DIR    contracts/escrow/bindings (git-ignored; uploaded as a CI artifact)
#
# Requires the `stellar` CLI on PATH.
#
# Exit codes:
#   0  bindings generated and the typed client matches the contract
#   1  WASM / CLI missing, generation failed, or the method sets differ

set -euo pipefail

WASM_PATH="${1:-contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm}"
OUT_DIR="${2:-contracts/escrow/bindings}"
CLIENT_TS="backend/contracts/escrow/index.ts"

if [[ ! -f "${WASM_PATH}" ]]; then
  echo "ERROR: WASM not found at ${WASM_PATH}" >&2
  echo "Run the release build first:" >&2
  echo "  cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32-unknown-unknown --release" >&2
  exit 1
fi

if ! command -v stellar >/dev/null 2>&1; then
  echo "ERROR: the 'stellar' CLI is not installed (https://developers.stellar.org/docs/tools/cli)" >&2
  exit 1
fi

stellar contract bindings typescript \
  --wasm "${WASM_PATH}" \
  --output-dir "${OUT_DIR}" \
  --overwrite

GENERATED_TS="${OUT_DIR}/src/index.ts"
if [[ ! -f "${GENERATED_TS}" ]]; then
  echo "ERROR: expected generated client at ${GENERATED_TS}" >&2
  exit 1
fi

# Methods declared by the typed client's ESCROW_METHODS list.
client_methods="$(
  sed -n '/^export const ESCROW_METHODS = \[/,/\] as const;/p' "${CLIENT_TS}" |
    grep -oE "'[a-z_]+'" | tr -d "'" | sort -u
)"

# Methods on the generated `Client` interface (one `  name: (` line each).
generated_methods="$(
  sed -n '/^export interface Client {/,/^}/p' "${GENERATED_TS}" |
    grep -oE '^  [a-z_]+: \(' | sed -E 's/^  ([a-z_]+): \(/\1/' | sort -u
)"

if [[ -z "${generated_methods}" ]]; then
  echo "ERROR: could not read any methods from ${GENERATED_TS}" >&2
  exit 1
fi

if [[ "${client_methods}" != "${generated_methods}" ]]; then
  echo "ERROR: ${CLIENT_TS} is out of sync with the escrow contract." >&2
  echo "Diff (< typed client, > contract bindings):" >&2
  diff <(echo "${client_methods}") <(echo "${generated_methods}") >&2 || true
  exit 1
fi

echo "OK: escrow bindings generated in ${OUT_DIR}; typed client covers all $(echo "${generated_methods}" | wc -l | tr -d ' ') methods."
