/**
 * tests/fuzz/x402_schema.test.ts
 *
 * Property-based fuzz tests for X402ChallengeSchema (issue #241) -- the x402
 * challenge schema is a security boundary (it's parsed directly from a
 * base64-decoded memo payload, see backend/agent.ts's stream handler), so it
 * must never hang, crash, or silently return something other than a parsed
 * value or a ZodError for arbitrary input.
 *
 * Previously this file used node:test + a `node:assert` import named
 * `expect` (which node:assert does not export) and only fuzzed raw strings
 * that mostly failed JSON.parse before ever reaching the schema -- it did
 * not actually run under this project's test runner (vitest picks up every
 * tests/**\/*.test.ts file per vitest.config.ts, and `npm run test:fuzz`
 * runs `vitest run tests/fuzz/**`) and barely exercised the schema. Rewritten
 * to use vitest (matching every other test file in this repo) and to fuzz
 * both arbitrary JSON-shaped values and structurally-valid challenge objects.
 */
export {};
//# sourceMappingURL=x402_schema.test.d.ts.map