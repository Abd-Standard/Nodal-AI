# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed — BREAKING

- **Node 22 LTS is now required** (`engines.node >=22.0.0`, `.nvmrc`). Node 20 reached end-of-life in April 2026; the Dockerfile, CI and devcontainer now run Node 22, and `@types/node` follows.
- **`@stellar/stellar-sdk` upgraded from 13.3.0 to 15.1.0** (Protocol 23 and 26 XDR). Breaking changes that affect code built on this repo:
  - `rpc.Api.EventResponse.pagingToken` was removed — use the event `id` (or the response's top-level `cursor`) to page `getEvents`. `ContractEventListener` now resumes from `event.id`.
  - `rpc.Server.GetEventsRequest` is deprecated in favour of `rpc.Api.GetEventsRequest`, and `getEvents` now needs either a ledger range or a cursor.
  - `getTransaction` / `getTransactions` no longer return `events.diagnosticEventsXdr`.
  - Sized XDR integers now throw on overflow instead of silently clamping, and `TransactionBase.networkPassphrase` can no longer be reassigned.
  - Horizon balance changes no longer carry `destination_muxed_id_type`.
  - `rpc.Server.requestAirdrop` is deprecated in favour of `fundAddress`.
- `balanceHelpers.ts` now reads Horizon balances through the SDK's `HorizonApi.BalanceLine` union instead of an untyped cast.

### Added

- Numbered schema migrations (`backend/db/migrations/NNN_*.sql`) applied at startup inside a transaction and tracked in a `schema_version` table. Existing databases are adopted in place; tables are no longer created ad hoc in `persistence.ts` / `nonce_store.ts`. This also restores the `audit_log` table and its append-only triggers.
- Postgres storage backend (`STORAGE_BACKEND=postgres`, `DATABASE_URL`) for multi-instance deployments, behind a `Storage` interface with SQLite as the default. Spending reservations lock a row with `SELECT … FOR UPDATE`; x402 nonces are shared across instances. A `postgres` docker-compose profile runs a Postgres-backed agent and the shared storage test suite.

- CI job (`wasm-size-check`) that fails when the compiled contract WASM exceeds a size budget, detecting supply-chain bloat such as injected data segments before deployment — see `scripts/check_wasm_size.sh` and `contracts/escrow/WASM_SIZE_BUDGET.md`
- Enhanced documentation for vitest configuration, including detailed explanation of `isolate: true` behavior and coverage thresholds
- Inline comments in `tests/soroban_invoke.test.ts` explaining mock architecture and test isolation patterns
- CHANGELOG.md following Keep a Changelog format for tracking releases and changes
- `SorobanInvokeTool` now enforces the spending limit on contract invocations: simulated Stellar Asset Contract transfers that debit the agent are summed from the mandatory Soroban simulation and checked against `AGENT_SPENDING_LIMIT` (and the mainnet cap) before broadcast, and within-limit spends are recorded into the cumulative spending window

- Destination pre-flight checks before signing `stellar_payment` and `path_payment` (#788): a missing account raises `DestinationNotFoundError` (suggesting `createAccount` with at least 1 XLM for XLM payments), a missing trustline raises `MissingTrustlineError`, and a destination that sets SEP-29 `config.memo_required` with no memo attached raises `MemoRequiredError`
- MPP Charge client (`backend/payments/mpp.ts`, `protocol: 'mpp-charge'`) for facilitator-free per-request payments through a SEP-41 `transfer`, using the agent signer and spending policy (#777)
- OpenAPI discovery document for paid endpoints at `/.well-known/openapi.json`, generated from route config with `x-payment-info` price/asset/network offers (`backend/x402/middleware.ts`, #781)
- `account_info` returns the read-only legacy `inflationDestination` (#782)

### Deprecated

- The `inflation` task type and `InflationTool` (#782). Inflation has been disabled on Stellar since protocol 12, so the tool has no effect; every execution now logs a deprecation warning. They will be removed in the next minor release (tracked in #874). Read an account's inflation destination from `account_info` instead.

### Fixed

- Quick Start code blocks in README.md — commands are now properly enclosed in fenced code blocks
- `prepareSorobanTx` no longer rejects source-account Soroban authorization entries as "Unexpected Soroban auth signer format"; only address credentials are checked against the agent key

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
