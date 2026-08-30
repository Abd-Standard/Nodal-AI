#!/usr/bin/env bash
#
# .devcontainer/post-create.sh
#
# Provisions the devcontainer after creation: installs the Rust toolchain
# used by the escrow contract, adds the wasm32-unknown-unknown target,
# installs the Stellar CLI, and installs Node dependencies.
#
# Run automatically by devcontainer.json's postCreateCommand. Safe to re-run.

set -euo pipefail

echo "==> Installing Rust via rustup..."
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
fi
# shellcheck disable=SC1090
source "$HOME/.cargo/env"

echo "==> Adding wasm32-unknown-unknown target..."
rustup target add wasm32-unknown-unknown

# contracts/escrow pins its own toolchain via rust-toolchain.toml — install it
# and the same target for it up front so the first `cargo build` in that
# directory doesn't stall on a cold download.
if [ -f "contracts/escrow/rust-toolchain.toml" ]; then
  echo "==> Installing pinned Rust toolchain for contracts/escrow..."
  (cd contracts/escrow && rustup show >/dev/null && rustup target add wasm32-unknown-unknown)
fi

echo "==> Installing Stellar CLI (stellar-cli)..."
if ! command -v stellar >/dev/null 2>&1; then
  cargo install --locked stellar-cli
fi

echo "==> Installing npm dependencies..."
npm install

echo "==> Devcontainer setup complete."
stellar --version || true
rustc --version || true
node --version || true
