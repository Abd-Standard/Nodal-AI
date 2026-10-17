# WASM Size Budget

The escrow contract compiles to a WebAssembly binary
(`target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm`). CI enforces a
size budget on that artifact to detect **supply-chain bloat** before deployment:
a compromised dependency or build step can silently inflate a WASM binary by
injecting large data segments, and the binary would still load and run normally.

## Current Budget

| Setting | Value |
| :--- | :--- |
| Budget | **120,000 bytes** (~117 KiB) |
| Where enforced | `.github/workflows/ci.yml` → `wasm-size-check` job |
| Check script | `scripts/check_wasm_size.sh` |
| Override | `MAX_WASM_SIZE_BYTES` environment variable |

## Why 120,000 bytes?

- Stellar's network hard limit for deployable contract WASM is **128 KiB
  (131,072 bytes)**. The budget must sit below that limit, otherwise a binary
  could pass CI and still be rejected at deploy time.
- 120,000 bytes leaves ~11 KB of headroom under the network limit, so the check
  fails before an artifact becomes undeployable.
- The escrow contract is small; a legitimate release build is far below this
  threshold, so the budget does not constrain normal development, while still
  failing loudly if an attack injects a large data segment into the binary.
- The budget is deliberately **explicit and adjustable**: when the contract
  legitimately outgrows it, raise `MAX_WASM_SIZE_BYTES` in CI as part of the
  change that grew the contract — never silently, and never above 131,072 bytes.

## How the check works

1. CI builds the contract: `cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32-unknown-unknown --release`
2. `scripts/check_wasm_size.sh` verifies the output is a valid WASM binary
   (magic bytes `\0asm`), reads its size in bytes with `stat`, and exits non-zero
   if the size exceeds the budget.
3. The GitHub Actions job fails, blocking merge until the bloat is investigated.

## Related context

- Stellar's current network hard limit for deployable contract WASM is
  **128 KiB (131,072 bytes)**; the budget above is set below it on purpose.
- Run the check locally with:
  ```bash
  cargo build --manifest-path contracts/escrow/Cargo.toml --target wasm32-unknown-unknown --release
  npm run check:wasm-size
  ```
