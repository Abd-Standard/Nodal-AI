# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `main`  | ✅ Active security patches |
| `< 1.0` | ❌ No longer supported |

Only the latest commit on `main` receives security patches at this stage of the project. Pin to a specific commit SHA if you need a stable, audited snapshot.

---

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use [GitHub Private Security Advisories](https://github.com/Dami24-hub/nodal-ai/security/advisories/new) to report vulnerabilities confidentially. This keeps details private until a fix is released.

### Response SLA

| Milestone | Target |
| --------- | ------ |
| Acknowledgement | ≤ 48 hours |
| Initial triage & severity assessment | ≤ 5 business days |
| Patch or mitigation for Critical/High | ≤ 14 days |
| Patch or mitigation for Medium/Low | ≤ 30 days |
| Public disclosure (coordinated) | After patch is released |

We follow [coordinated vulnerability disclosure](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html). Researchers who report responsibly will be credited in the release notes unless they prefer anonymity.

---

## Core Security Invariants

The following invariants are enforced throughout the codebase. Any contribution that weakens them will be rejected.

### 1. Zero Hardcoding (Secret Hygiene)

All sensitive credentials — `AGENT_SECRET_KEY`, RPC endpoints, asset issuers — are sourced exclusively from environment variables and validated at startup via Zod schemas (`backend/config.ts`). No secrets appear in source code, committed configuration files, or log output.

**Enforcement:**
- `.env` is `.gitignore`d; `..env` contains only placeholder values.
- Zod validation error messages strip any value matching a Stellar secret-key pattern (`S[A-Z2-7]{55}`) before writing to stderr (`formatValidationErrors` in `backend/config.ts`).
- CI pipelines must never inject real secret keys into build logs.

### 2. Transaction Simulation (Pre-execution Validation)

Every Soroban transaction is passed through `prepareSorobanTx` (Soroban RPC simulation) before it is signed or broadcast. Simulation catches fee estimation errors, authorization failures, and contract-level panics without spending funds or mutating on-chain state.

**Enforcement:**
- The sign → submit path is only reachable after a successful simulation response.
- A failed simulation aborts the operation and surfaces a structured error to the agent loop, preventing silent fund loss.

### 3. Challenge Validation (Cryptographic Intent Verification)

Before any x402 payment is triggered, the incoming challenge is validated for:
- **Schema correctness** — all required fields present and correctly typed.
- **Expiry** — the challenge timestamp is within the accepted window; stale challenges are rejected.
- **Asset match** — the requested asset code and issuer are compared against the agent's configured `X402_ASSET_CODE` / `X402_ASSET_ISSUER` values.

**Enforcement:**
- Validation runs before any keypair access or transaction construction.
- Challenges failing any check are dropped without triggering a payment.

---

## Secret Management: The `agentKeypair()` Closure

`AGENT_SECRET_KEY` has a single, controlled access path in the entire codebase.

### How it works (`backend/config.ts`)

```typescript
// 1. Raw secret parsed from env — never leaves this scope
const { AGENT_SECRET_KEY: _secret, AGENT_PUBLIC_KEY: _rawPub, ...rest } = raw;

// 2. AgentConfig interface explicitly excludes the secret key
export interface AgentConfig extends Omit<RawEnv, "AGENT_SECRET_KEY" | "AGENT_PUBLIC_KEY"> {
  readonly AGENT_PUBLIC_KEY: string;   // safe to log
  readonly agentKeypair: () => Keypair; // explicit, call-site access only
}

// 3. Secret captured in closure — never placed on the config object
const cfg: AgentConfig = {
  ...rest,
  AGENT_PUBLIC_KEY: derivedPublicKey,
  agentKeypair: () => Keypair.fromSecret(_secret),
};
```

### Why this matters

| Risk | Mitigation |
| ---- | ---------- |
| Accidental `console.log(config)` leaks the secret | Secret is absent from the `config` object entirely — it only exists inside the `loadConfig` closure scope. |
| Serialization (e.g. `JSON.stringify(config)`) captures the secret | `agentKeypair` is a function reference; functions are silently dropped by JSON serialization. |
| Log aggregators capturing structured config objects | `AGENT_SECRET_KEY` is removed via destructuring before `cfg` is constructed; it cannot appear in any downstream spread. |
| Zod validation errors echoing the raw value | `formatValidationErrors` applies a regex redaction pass over all error messages before writing to stderr. |

**Calling convention:** code that needs to sign a transaction must call `config.agentKeypair()` explicitly. This deliberate friction makes secret access visible at review time and auditable via static analysis.

---

## Additional Hardening Notes

- **Mainnet spending cap:** `AGENT_SPENDING_LIMIT` is rejected at startup if it exceeds `10,000` on `mainnet`, preventing runaway agent spend.
- **Exponential back-off:** All RPC calls use retry logic with jitter to reduce the attack surface of timing-based denial-of-service against the agent.
- **Dependency pinning:** Keep `package.json` dependencies pinned to exact versions and audit regularly with `npm audit`.
