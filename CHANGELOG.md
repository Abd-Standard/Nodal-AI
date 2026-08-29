# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- CI job (`wasm-size-check`) that fails when the compiled contract WASM exceeds a size budget, detecting supply-chain bloat such as injected data segments before deployment — see `scripts/check_wasm_size.sh` and `contracts/escrow/WASM_SIZE_BUDGET.md`
- Enhanced documentation for vitest configuration, including detailed explanation of `isolate: true` behavior and coverage thresholds
- Inline comments in `tests/soroban_invoke.test.ts` explaining mock architecture and test isolation patterns
- CHANGELOG.md following Keep a Changelog format for tracking releases and changes
- `SorobanInvokeTool` now enforces the spending limit on contract invocations: simulated Stellar Asset Contract transfers that debit the agent are summed from the mandatory Soroban simulation and checked against `AGENT_SPENDING_LIMIT` (and the mainnet cap) before broadcast, and within-limit spends are recorded into the cumulative spending window

### Fixed

- Quick Start code blocks in README.md — commands are now properly enclosed in fenced code blocks

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
[Unreleased]: https://github.com/your-repo/compare/v[latest]...HEAD
[X.Y.Z]: https://github.com/your-repo/releases/tag/v[X.Y.Z]
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
