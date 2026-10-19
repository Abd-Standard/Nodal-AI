#!/usr/bin/env bash
#
# build_escrow_wasm.sh — reproducible release build of the escrow contract.
#
# Produces the same WASM bytes (and therefore the same Soroban WASM hash) on
# any machine:
#   - the Rust toolchain is pinned by rust-toolchain.toml
#   - dependencies are pinned by contracts/escrow/Cargo.lock (--locked)
#   - host-specific absolute paths are remapped out of the binary
#   - incremental compilation is disabled
#
# Writes <wasm>.sha256 next to the artifact. Used by scripts/deploy_escrow.ts
# and by the release workflow, which attaches both files to the GitHub Release.
#
# Usage:
#   scripts/build_escrow_wasm.sh
#
# Prints the artifact path and its SHA-256 (the Soroban WASM hash).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${ROOT}/contracts/escrow/Cargo.toml"
WASM_PATH="${ROOT}/contracts/escrow/target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm"
CARGO_HOME_DIR="${CARGO_HOME:-${HOME}/.cargo}"

export CARGO_INCREMENTAL=0
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "${ROOT}" log -1 --format=%ct)}"
export RUSTFLAGS="--remap-path-prefix=${ROOT}=/nodal --remap-path-prefix=${CARGO_HOME_DIR}=/cargo"

rustup target add wasm32-unknown-unknown >/dev/null
cargo build --locked --manifest-path "${MANIFEST}" --target wasm32-unknown-unknown --release

if command -v sha256sum >/dev/null 2>&1; then
  HASH=$(sha256sum "${WASM_PATH}" | awk '{print $1}')
else
  HASH=$(shasum -a 256 "${WASM_PATH}" | awk '{print $1}')
fi

echo "${HASH}  stellar_payfi_escrow.wasm" > "${WASM_PATH}.sha256"

echo "WASM:   ${WASM_PATH}"
echo "SHA256: ${HASH}"
