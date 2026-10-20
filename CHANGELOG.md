# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **x402 v2 interoperability** with official @x402/* packages (@x402/stellar, @x402/fetch, @x402/express, @x402/core)
  - V2 buyer path using SEP-41 token transfers and exact scheme
  - V2 seller middleware using @x402/express for Express.js applications
  - Optional facilitator support for verification/settlement via `/verify`, `/settle`, `/supported` endpoints
  - CAIP-2 network ID support (`stellar:testnet`, `stellar:pubnet`)

- **`X402_USE_LEGACY` env var** — when `true` (default: `0` = `false`), uses legacy SHA-256(nonce)[0:28] memo flow; when `false`, uses x402 v2 with SEP-41

- **`X402_FACILITATOR_URL` env var** — optional facilitator URL for x402 v2 verification/settlement

- `X402PaymentTool.respondV2()` — v2 buyer implementation with automatic dispatch based on `X402_USE_LEGACY` flag

- `createX402Middleware()` in `backend/x402/server.ts` — Express middleware factory supporting both v2 (official @x402/express) and legacy JSON challenge formats

- **x402 v2 interoperability test suite** (`tests/x402_interop.test.ts`) covering legacy path, v2 buyer, v2 seller middleware, flag isolation, and facilitator validation

### Changed

- **`X402_USE_LEGACY` flag default** — now defaults to `0` (false), enabling x402 v2 by default. Set to `1` to use legacy flow for backward compatibility.

- `X402PaymentTool.respond()` now automatically dispatches to `respondV2()` when `X402_USE_LEGACY === false`, else uses legacy SHA-256 memo flow.

### Deprecated

- Legacy JSON challenge format with SHA-256(nonce)[0:28] memo — will be removed in next major release. Set `X402_USE_LEGACY=1` to continue using legacy flow during migration.

### Removed

- None

### Fixed

- None

### Security

- None

### Migration Notes

#### Upgrading to x402 v2

**Default behavior change**: x402 v2 is now enabled by default (`X402_USE_LEGACY=0`). To continue using the legacy flow during migration, set:

```bash
X402_USE_LEGACY=1
```

**For x402 buyers (clients)**:
- v2 challenges include `x402Version: '2.0'` or `accepts: [{ scheme: 'exact', ... }]`
- Legacy challenges are plain JSON objects without these fields
- The agent's `X402PaymentTool.respond()` automatically detects the version and routes appropriately

**For x402 sellers (servers)**:
- Use `createX402Middleware()` from `backend/x402/server.ts`
- When `X402_USE_LEGACY=true`, returns JSON challenges (compatible with older clients)
- When `X402_USE_LEGACY=false` (default), returns x402 v2 challenges with header-based protocol

**Facilitator integration** (optional):
- Set `X402_FACILITATOR_URL=https://facilitator.example.com` to enable facilitator-based verification/settlement
- When unset, SEP-41 payments are still supported but facilitator calls are skipped

**Testing migration**:
1. Set `X402_USE_LEGACY=1` to test legacy flow
2. Verify all existing clients/servers work correctly
3. Set `X402_USE_LEGACY=0` and test v2 flow
4. Gradually migrate clients/servers to v2
5. Remove `X402_USE_LEGACY=1` once all integrations are on v2

---

## Versioning & Release Process

When releasing a new version:

1. Choose a version number following [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH)
2. Create a new section header in this file:
   ```markdown
   ## [X.Y.Z] - YYYY-MM-DD
   ```
3. Move items from **[Unreleased]** to the new section, organized by:
   - **Added** — new features
   - **Changed** — changes in existing functionality
   - **Deprecated** — soon-to-be removed features
   - **Removed** — removed features
   - **Fixed** — bug fixes
   - **Security** — security fixes and improvements
4. At the bottom of the file, add comparison links (example format shown below)
5. Create a Git tag: `git tag -a v[X.Y.Z] -m "Release version X.Y.Z"`
6. Push the tag: `git push origin v[X.Y.Z]`

### Link Format (Bottom of File)

```markdown
[Unreleased]: https://github.com/Nodal-stellar/Nodal-AI/compare/v[latest]...HEAD
[X.Y.Z]: https://github.com/Nodal-stellar/Nodal-AI/releases/tag/v[X.Y.Z]
```

---

## Guidelines

- **Be descriptive**: Use clear, user-facing language. Users should understand what changed and why it matters.
- **Group logically**: Use the six standard section types (Added, Changed, Deprecated, Removed, Fixed, Security).
- **Link to issues/PRs**: Reference issue numbers and pull requests where applicable (e.g., `(#123)`).
- **Date format**: Use ISO 8601 format (YYYY-MM-DD) for release dates.
- **Unreleased section**: Keep the [Unreleased] heading at the top for work-in-progress changes.

---

## Example Entry

```markdown
## [0.2.0] - 2026-02-15

### Added

- X402PaymentTool now validates challenge schema before submission (#45)
- SorobanInvokeTool supports `simulateOnly` mode for dry-run operations (#38)

### Fixed

- Fixed race condition in polling timeout logic for transaction confirmation (#52)
- Corrected memo truncation in X402 nonce derivation (#49)

### Changed

- Increased Soroban RPC polling timeout from 10s to 15s to accommodate slower networks (#51)

### Security

- Updated @stellar/stellar-sdk to v11.4.0 to address XDR parsing vulnerability (#48)
```

---

For questions or feedback on this changelog, see [CONTRIBUTING.md](./CONTRIBUTING.md).

/
├── backend/            # Pillar 1: Agent Orchestration (TypeScript/Node.js)
│   ├── db/             # Local database layers / state tracking
│   ├── middleware/     # HTTP middleware (centralised error handling in error_handler.ts)
│   ├── tools/          # Individual agent tools (StellarPaymentTool, SorobanInvokeTool, X402PaymentTool)
│   ├── types/          # Domain-specific type and schema validation definitions
│   ├── utils/          # Shared helpers (logger.ts, stellarSchemas.ts)
│   ├── agent.ts        # The main orchestrator class (PayFiAgent)
│   ├── config.ts       # Secure configuration layer and environment schema validations
│   └── rpc_client.ts   # Central network gateway with observability, retries, and simulation gates
├── contracts/          # Pillar 2: Soroban Smart Contracts (Rust)
│   └── escrow/         # Production-grade Soroban escrow contract (src/lib.rs, src/test.rs)
└── tests/              # Pillar 3: Integration & E2E Tests (Vitest & TypeScript)
    ├── payment.test.ts # Stellar native/asset payment verification tests
    ├── x402.test.ts    # E2E x402 protocol integration tests
    └── soroban_invoke.test.ts # Smart contract invocation tests
```
