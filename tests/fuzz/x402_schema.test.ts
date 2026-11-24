/**
 * tests/fuzz/x402_schema.test.ts
 *
 * Property-based fuzz test for X402ChallengeSchema.
 * SafeParse must never throw and always report a boolean success flag.
 */

import { it, expect, vi } from "vitest";
import fc from "fast-check";

// X402PaymentTool imports the real config singleton at module load, which
// validates env vars and calls process.exit when they are missing. Mock it so
// the schema can be fuzzed without any environment setup.
vi.mock("../../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    AGENT_SPENDING_LIMIT: "100",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    agentKeypair: () => {
      throw new Error("not used in schema fuzz test");
    },
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

vi.mock("../../backend/rpc_client", () => ({
  horizonServer: {},
  sorobanServer: {},
}));

vi.mock("../../backend/persistence", () => ({
  saveResult: vi.fn(),
  getResults: vi.fn().mockReturnValue([]),
  _setDb: vi.fn(),
}));

it("X402ChallengeSchema fuzz test", async () => {
  const { X402ChallengeSchema } = await import(
    "../../backend/tools/X402PaymentTool"
  );

  await fc.assert(
    fc.asyncProperty(fc.string(), async (jsonString) => {
      // Attempt to parse JSON; if it fails, schema validation rejects anyway
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonString);
      } catch {
        // non-JSON strings are ok to reject
        return;
      }
      const result = X402ChallengeSchema.safeParse(parsed);
      // The schema should never throw; safeParse returns a success boolean
      expect(typeof result.success).toBe("boolean");
    })
  );
});
