# Contributing to Nodal AI

Thank you for your interest in contributing to Nodal AI! This document outlines our contribution workflow and guidelines.

---

## Stellar Wave & Drips Points

Nodal AI participates in the **[Stellar Wave](https://stellar.org/wave)** programme — a developer contribution sprint where every merged PR on a labelled issue earns you **Drips points** that can be redeemed within the Stellar ecosystem.

### What are Drips points?

Drips points are contribution credits issued by the Stellar Development Foundation to reward open-source work. Points are tracked per-contributor and accumulated over each sprint cycle.

### How to earn points

1. **Find a Wave-eligible issue**: Browse the [Issues](https://github.com/Nodal-stellar/Nodal-AI/issues) tab and filter by `good first issue`, `help wanted`, or any issue carrying a `complexity: <score>` label.
2. **Claim the issue**: Comment on it so maintainers can assign it to you and avoid duplicate work.
3. **Submit a PR**: Reference the issue number (`Closes #<number>`) in your PR description. Follow the branch-naming and commit-message conventions below.
4. **Get it merged**: Once your PR passes CI and review, it is merged and your Drips points are recorded.

### Sprint cycle cadence

Stellar Wave runs in **two-week sprints**. Issues labelled for the current sprint are prioritised for review. Check the project board or issue comments for the active sprint tag.

### Finding Wave-eligible issues

| Filter | What it means |
|---|---|
| `good first issue` | Well-scoped, low-complexity tasks ideal for new contributors |
| `help wanted` | Explicitly open for community contributions |
| `complexity: 100` | Small tasks (~1–2 h); earn **100 Drips points** on merge |
| `complexity: 150` | Medium tasks (~3–4 h); earn **150 Drips points** on merge |
| `complexity: 200` | Larger tasks (~5+ h); earn **200 Drips points** on merge |

### Drips points table

| Complexity Score | Estimated effort | Drips points awarded |
|:-:|:-:|:-:|
| 100 | ~1–2 hours | 100 |
| 150 | ~3–4 hours | 150 |
| 200 | ~5+ hours | 200 |

Points are awarded **once per merged PR** on an issue carrying a `complexity` label. A single PR that closes multiple issues earns the sum of their individual scores.

---

## Stellar Wave Sprint Workflow

We are actively participating in the **Stellar Wave** program! Here's how you can earn Drips points for your contributions:

1. **Find an Issue**: Browse the [Issues](https://github.com/Nodal-stellar/Nodal-AI/issues) tab for tickets tagged `good first issue` (ideal for new contributors) or `help wanted`.
2. **Claim the Issue**: Comment on the issue to let maintainers know you're working on it.
3. **Submit a PR**: Follow the guidelines below and reference the issue in your PR.
4. **Earn Drips Points**: Once your PR is merged, you'll be eligible for Drips points!

---

## Branch Naming

Please use these prefixes for your branches:
- `feat/<description>`: New features
- `fix/<description>`: Bug fixes
- `docs/<description>`: Documentation updates
- `test/<description>`: Test additions or improvements
- `refactor/<description>`: Code refactoring

Example:
```bash
git checkout -b feat/33-add-dev-env-validation
```

---

## Commit Message Format

We follow the **Conventional Commits** specification. Your commit messages should be structured like this:

```
<type>(<scope>): <description>
```

Examples:
- `feat(#33): Add environment validation to dev.sh`
- `fix: Handle RPC timeouts gracefully`
- `docs: Update CONTRIBUTING.md with branch naming rules`
- `test: Add coverage for x402 payment tool`

---

## Pull Request Checklist

Before submitting your PR, make sure:
- ✅ All tests pass (`npm run test:all` and `cargo test --manifest-path contracts/escrow/Cargo.toml`)
- ✅ TypeScript compiles cleanly (`npm run build` and `tsc --noEmit`)
- ✅ Linting passes (`npm run lint`)
- ✅ No npm or Cargo vulnerabilities introduced (`npm run audit`)
- ✅ All tests pass (`npm run test:all`, which runs `cargo test` for the escrow contract and the TypeScript suite)
- ✅ TypeScript compiles cleanly (`tsc --noEmit`)
- ✅ Linting passes (`npm run lint`)
- ✅ Formatting passes (`npm run format:check`) — run `npm run format` to auto-fix
- ✅ No secrets or private keys are in the diff
- ✅ You've referenced the issue number in your PR description
- ✅ Your branch is up to date with `main` (required by branch protection)

---

## Development Workflow

1. **Check Issues**: Browse the [Issues](https://github.com/Nodal-stellar/Nodal-AI/issues) tab for tickets tagged `good first issue` or `help wanted`.

2. **Create a Feature Branch**:
   ```bash
   git checkout -b feat/<issue-number>-<description>
   # Example: git checkout -b feat/30-github-actions-ci
   ```

3. **Make Your Changes**:
   - Follow the project structure in `README.md`
   - Ensure all tests pass: `npm run test:all`
   - Run the linter: `npm run lint`
   - Check formatting: `npm run format:check` (or `npm run format` to auto-fix)
   - For TypeScript changes, compile: `npm run build`
   - For Rust changes, test: `cargo test --manifest-path contracts/escrow/Cargo.toml`

4. **Commit with Clear Messages**:
   ```bash
   git commit -m "feat(#30): Add GitHub Actions CI workflow"
   ```

5. **Push and Open a Pull Request**:
   ```bash
   git push origin feat/<issue-number>-<description>
   ```

### Snapshot Tests

Vitest snapshot tests (e.g., `tests/__snapshots__/agent.test.ts.snap`) lock down the serialization contracts and payload shapes of `AgentResult` across tools to prevent breaking webhook consumers.

When your changes intentionally alter an output shape:
- Update snapshots intentionally using `npm run test:ts -- -u` or `npx vitest run -u <path-to-test>`.
- Review the diff in `tests/__snapshots__/*.snap` to ensure all modified fields are intentional and backwards-compatible.
- **Never update snapshots blindly** just to make tests pass; always commit the updated snapshots with your PR.

### Mutation & Fuzz Testing

Two optional quality tools go beyond the standard suite. Neither runs in CI by default — run them locally when you touch the code they target.

**Mutation testing** (`npm run test:mutation`) runs [Stryker](https://stryker-mutator.io/) against the TypeScript suite using `stryker.config.mjs`. Stryker mutates your source (flipping comparisons, removing conditionals, altering return values) and re-runs the tests to see whether they catch the change. A surviving mutant means a test gap. This is most valuable on **validation-heavy code** — Zod schemas and payment math — where a subtly wrong boundary or arithmetic branch can slip past tests that only assert the happy path. Run it when you add or change validation rules, amount/limit calculations, or anything in the payment tools, and use the surviving-mutant report to add the missing assertions.

**Fuzz testing** (`npm run test:fuzz`) runs the property-based tests under `tests/fuzz/` with Vitest. These feed randomized and edge-case inputs (malformed payloads, extreme amounts, boundary values) into the same validation and payment paths to surface crashes, unhandled rejections, and schema inputs that should be rejected but aren't. Run it when you change input schemas, parsing, or numeric handling, and add a fuzz case whenever you fix a bug that a random input could have caught.

---

## Adding a New Tool

The most common contribution to this repo is adding a new tool to the agent (e.g. a new Stellar operation). Follow this checklist rather than reverse-engineering the pattern from existing tools:

1. **Create `backend/tools/YourTool.ts`** with a Zod input schema, a class with an `execute()` (or similarly-named) method, and JSDoc on the exported schema/class. Look at `backend/tools/StellarPaymentTool.ts` for the shape: exported `YourToolInputSchema`, an inferred `YourToolInput` type, and a class that validates its input with `YourToolInputSchema.parse(rawInput)` before doing anything else.
2. **Add a new task type** to the `TaskType` union in `backend/agent.ts` (e.g. `"your_task"`).
3. **Import and instantiate your tool** in the `PayFiAgent` constructor in `backend/agent.ts`, alongside the existing tool instances (`paymentTool`, `sorobanTool`, `x402Tool`, etc.).
4. **Add a `case "your_task":`** to the `switch` in `PayFiAgent.run()` (`backend/agent.ts`) that delegates to your tool's execute method, matching the existing cases (`"stellar_payment"`, `"soroban_invoke"`, `"x402_respond"`, ...).
5. **Add a mock for your tool** in every test file's `vi.mock("../backend/tools/YourTool")` block that exercises `agent.ts` (e.g. wherever `PayFiAgent`/`run()` is tested), so agent-level tests don't hit the real network.
6. **Create `tests/your_tool.test.ts`** covering input validation (schema edge cases), the happy path, and network/error handling — see `tests/payment.test.ts` for the expected level of coverage (validation, happy path, network errors, retry exhaustion, state verification).
7. **Add an entry to the README's [API Reference](./README.md#api-reference) table** (`TaskType` union and the `PayFiAgent` method table) describing the new task type.
8. **Update [ARCHITECTURE.md](./ARCHITECTURE.md)'s** tool list and task-routing diagram/description so the new tool shows up alongside the others.

---

## Automated Checks

All pull requests are automatically validated by GitHub Actions. The CI workflow (`.github/workflows/ci.yml`) runs the following jobs, **all of which are required status checks** on `main` (see Branch Protection Rules above):

| Job | Command | Requirement |
|-----|---------|-------------|
| **Build** | `npm run build` | TypeScript must compile with zero errors |
| **Lint** | `npm run lint` | ESLint must report zero errors |
| **Test** | `npm run test:all` | All TypeScript and Rust tests must pass |
| **Test Rust** | `cargo test` | Soroban contract tests must pass |
| **Lint Rust** | `cargo clippy` + `cargo fmt --check` | No Clippy warnings or formatting issues |
| **Audit npm** | `npm run audit` | No high or critical npm vulnerabilities |
| **Audit Rust** | `cargo audit` | No Cargo dependency advisories |

All jobs **must pass** before your PR can be merged. A PR with a failing `build` job (e.g. TypeScript type errors) cannot be merged regardless of approvals.

---

## Local Git Hooks

This repository uses **Husky** to enforce code quality through local git hooks. These hooks run automatically before key git operations:

### Pre-Commit Hook (`.husky/pre-commit`)

Runs `scan-secrets.sh` to prevent accidental commits of sensitive data (API keys, private keys, etc.).

### Pre-Push Hook (`.husky/pre-push`)

**NEW**: Runs `npm test` automatically before allowing pushes to the remote repository.

This prevents broken tests from being pushed and failing only during CI checks. If your tests fail locally, the push is blocked with output showing which tests failed. Fix the failing tests and try pushing again.

**To bypass** (not recommended):
```bash
git push --no-verify
```

---

## Branch Protection Rules

> **Maintainer task (issue #727):** The rules below **must** be active on `main` before any further PRs are merged. Recent merges (#712–#714) landed while `tsc --noEmit` was failing because branch protection was not enforced. The rules prevent this from happening again.

Repository maintainers must enable the following branch protection rules on `main`:

### Required status checks

All of the following CI jobs **must** be added as required status checks and must pass before a PR can be merged:

| CI job | Command | What it checks |
|--------|---------|----------------|
| `build` | `npm run build` | TypeScript compiles without errors (`tsc`) |
| `lint` | `npm run lint` | ESLint passes for `backend/**/*.ts` and `tests/**/*.ts` |
| `test` | `npm run test:all` | Full TypeScript + Rust test suites |
| `test-rust` | `cargo test` | Soroban contract unit tests |
| `lint-rust` | `cargo clippy` + `cargo fmt --check` | Rust code quality |
| `audit-npm` | `npm run audit` | No high/critical npm vulnerabilities |
| `audit-rust` | `cargo audit` | No Cargo dependency advisories |

### Additional required rules

- **Require branches to be up to date before merging** — a PR must include all commits on `main` before the merge button is enabled. This prevents a PR that passes CI on a stale base from landing while main has moved to a broken state.
- **Require a pull request before merging** — direct pushes to `main` are blocked; all changes must go through a PR.
- **Dismiss stale pull request approvals when new commits are pushed** — an approval on an old revision cannot satisfy the review requirement.
- **Require at least 1 approving review** (recommended).

### How to configure

1. Go to **Settings** → **Branches** → **Branch protection rules**
2. Click **Add rule**, set branch name pattern to `main`
3. Enable:
   - ☑ **Require a pull request before merging**
   - ☑ **Require status checks to pass before merging**
     - ☑ **Require branches to be up to date before merging**
     - Search for and add each job name: `build`, `lint`, `test`, `test-rust`, `lint-rust`, `audit-npm`, `audit-rust`
   - ☑ **Dismiss stale pull request approvals when new commits are pushed**
4. Click **Save changes**

> **Note:** Status check names must exactly match the `jobs.<id>` keys in `.github/workflows/ci.yml`. If you rename a job, update the branch protection rule accordingly.

---

## Code Style

- **TypeScript**: Follow ESLint rules defined in `.eslintrc.cjs`
- **Rust**: Follow standard `cargo fmt` and Clippy recommendations
- **Env Access**: Always use `backend/config.ts` for environment variables, never `process.env` directly in tool code

---

## Dependency Auditing

To check for vulnerabilities in dependencies:
- **npm dependencies**: `npm run audit`
- **Fix vulnerabilities**: `npm audit fix` (use with caution)
- **Rust dependencies**: `cargo audit` (requires `cargo-audit` to be installed)

---

## Security

- Never commit sensitive credentials (private keys, API tokens, etc.)
- All secrets must be managed via environment variables
- Refer to [backend/config.ts](./backend/config.ts) for the canonical vault of config validation

---

## Code of Conduct

We are committed to providing a welcoming and inclusive environment for all contributors. Please:
- Be respectful and considerate of others
- Use inclusive language
- Accept constructive feedback gracefully
- Focus on what is best for the community

---

## Questions?

Open an issue on GitHub with the `question` label, and a maintainer will get back to you shortly.

---
- **Build**: Compiles TypeScript with `npm run build`
- **Lint**: Enforces code style with `npm run lint` and formatting with `npm run format:check`
- **Test**: Runs the Rust contract tests and the TypeScript suite with `npm run test:all`
- **Test Rust**: Validates Soroban contracts with `

/* … truncated 8272 chars — edit only what you need near the top … */
