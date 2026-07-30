import { describe, expect, it } from "vitest";
import { BalanceCheckInputSchema } from "../backend/tools/BalanceCheckTool";

describe("BalanceCheckInputSchema", () => {
  const validPublicKey = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  it("accepts valid Stellar public keys for both fields", () => {
    const parsed = BalanceCheckInputSchema.parse({
      publicKey: validPublicKey,
      assetIssuer: validPublicKey,
    });

    expect(parsed.publicKey).toBe(validPublicKey);
    expect(parsed.assetIssuer).toBe(validPublicKey);
  });

  it("rejects a publicKey that is not a valid Ed25519 public key", () => {
    expect(() =>
      BalanceCheckInputSchema.parse({
        publicKey: "G".repeat(56),
        assetIssuer: validPublicKey,
      })
    ).toThrow(/Invalid Stellar public key/);
  });

  it("rejects an assetIssuer that is not a valid Ed25519 public key", () => {
    expect(() =>
      BalanceCheckInputSchema.parse({
        publicKey: validPublicKey,
        assetIssuer: "G".repeat(56),
      })
    ).toThrow(/Invalid Stellar asset issuer/);
  });
});
