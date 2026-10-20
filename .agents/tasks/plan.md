# Implementation Plan: x402 v2 Interoperability

## Overview
Implement x402 v2 interoperability so Nodal agents can pay real x402 APIs and real x402 clients can pay Nodal-protected resources. This involves adding the official @x402/stellar package suite, implementing a v2 buyer/ seller protocol alongside the existing legacy flow, and maintaining backward compatibility via a flag.

## Background

### Current State
- `backend/tools/X402PaymentTool.ts` — custom JSON challenge with SHA-256(nonce)[0:28] memo; pays via classic Stellar payment.
- `backend/agent.ts` — `x402_respond` task delegates to `X402PaymentTool.respond()`.
- `backend/config.ts` — has `X402_ASSET_CODE`, `X402_ASSET_ISSUER`, `X402_ASSET_CONTRACT`. No facilitator or legacy-flag fields.
- No @x402/* packages installed.

### x402 v2 Protocol (Official)
- Uses HTTP header-based challenges (`PAYMENT-REQUIRED`, `PAYMENT`) instead of JSON bodies.
- Implements SEP-41 token transfers authorized by signed Soroban auth entries.
- Verified/settled by a facilitator service (`/verify`, `/settle`, `/supported`).
- CAIP-2 network IDs (`stellar:testnet`, `stellar:pubnet`).
- Official packages: `@x402/stellar`, `@x402/fetch`, `@x402/express`, `@x402/core`.

## Decision Log

### 1. Package Versions
**Decision:** Install the following exact versions from npm (verified 2025-06-25):
- `@x402/stellar@0.3.3` — Stellar-specific x402 tools and `ExactStellarScheme`.
- `@x402/fetch@0.3.3` — fetch wrapper for automatic 402 handling.
- `@x402/express@0.3.3` — Express middleware for seller endpoints.
- `@x402/core@0.3.3` — core types and validation (`X402Challenge`, `X402Payment`, etc.).

**Rationale:** These are the latest stable versions as of the latest commit on the main x402-stellar repo; they match the protocol spec and include SEP-41 token transfer support.

### 2. Legacy Flag Behavior
**Decision:** Introduce `X402_USE_LEGACY` env var (default `false` = v2). When `true`, route to legacy SHA-256 memo flow; when `false` (default), use v2.

**Rationale:** Allows one-release migration window without breaking existing integrations. Defaulting to v2 aligns with the industry-standard x402 implementation.

### 3. Facilitator URL Handling
**Decision:** Add `X402_FACILITATOR_URL` as optional env var. V2 buyer flow attempts facilitator verification/settlement when configured; if not set, skips facilitator calls and only constructs the SEP-41 payment payload.

**Rationale:** Not all deployments will use a facilitator; the protocol supports direct SEP-41 payments. Optional facilitator enables opt-in enhanced verification.

### 4. Buyer Path Decision
**Decision:** In `X402PaymentTool.respond()`, detect v2 challenges by presence of `x402Version` field or `accepts` array with scheme `exact`. Route to `respondV2()` for v2, legacy path otherwise.

**Rationale:** The incoming challenge format (JSON vs headers) determines the protocol. The `x402Version` field is the canonical indicator per the official spec.

## Implementation Steps

### 1. Install x402 packages
**What:** Add @x402/* packages to `package.json` dependencies and run `npm install`.
**Files:** `package.json`
**Verification:** `npm run typecheck` succeeds without unknown package errors.

### 2. Update `backend/config.ts`
**What:** Add `X402_USE_LEGACY` and `X402_FACILITATOR_URL` env vars with Zod schemas.
**Files:** `backend/config.ts`
**Verification:** `npm run typecheck` succeeds and config loading accepts valid env vars.

### 3. Update `backend/tools/X402PaymentTool.ts`
**What:** Implement `respondV2()` method that handles v2 challenges via @x402/stellar and SEP-41 token transfers; update `respond()` to dispatch based on `X402_USE_LEGACY`.
**Files:** `backend/tools/X402PaymentTool.ts`
**Verification:** `npm run test:ts -- tests/x402.test.ts` passes.

### 4. Create `backend/x402/server.ts`
**What:** New seller middleware factory using @x402/express and fallback to legacy flow.
**Files:** `backend/x402/server.ts`
**Verification:** New middleware compiles and exports `createX402Middleware`.

### 5. Update `backend/agent.ts` x402_respond dispatch
**What:** In `x402_respond` case, detect v2 challenge format and route to `respondV2()` when appropriate.
**Files:** `backend/agent.ts`
**Verification:** Existing `x402_respond` tests still pass.

### 6. Create `tests/x402_interop.test.ts`
**What:** Comprehensive test suite covering legacy path, v2 buyer, v2 seller, flag isolation, and facilitator validation.
**Files:** `tests/x402_interop.test.ts`
**Verification:** `npm run test:ts -- tests/x402_interop.test.ts` passes.

### 7. Update `CHANGELOG.md`
**What:** Add x402 v2 interoperability to [Unreleased] section under Added, Changed, and Migration Notes.
**Files:** `CHANGELOG.md`
**Verification:** changelog format matches project style.

### 8. Update `README.md`
**What:** Add section describing x402 v2 interoperability, env vars, and minimal usage code.
**Files:** `README.md`
**Verification:** README syntax is valid markdown.

## Dependencies
All items depend on successful completion of previous items. Specifically:
- Step 3 depends on Step 1 (packages must be installed before importing).
- Step 4 depends on Step 2 (middleware uses config values).
- Step 5 depends on Step 3 (agent dispatches to the new method).
- Step 6 depends on Steps 3 and 4 (tests must mock and verify both paths).

## Verification Commands
After implementation:
```bash
npm run typecheck
npm run lint
npm run test:ts -- tests/x402.test.ts
npm run test:ts -- tests/x402_interop.test.ts
```
All must pass without errors.
