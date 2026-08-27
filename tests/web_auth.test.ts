/**
 * tests/web_auth.test.ts
 * Tests for StellarIdentityTool (#388)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, TransactionBuilder, Operation, Networks, BASE_FEE } from "@stellar/stellar-sdk";

const { mockInfo } = vi.hoisted(() => ({
  mockInfo: vi.fn(),
}));

vi.mock("../backend/utils/logger", () => ({
  createLogger: () => ({ info: mockInfo, error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { StellarIdentityTool } from "../backend/tools/StellarIdentityTool";

vi.mock("../backend/config", () => {
  const { Keypair } = require("@stellar/stellar-sdk");
  const secret = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
  return {
    config: {
      STELLAR_NETWORK: "testnet",
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const TEST_SECRET = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
const ANCHOR_URL = "https://anchor.example.com";
const JWT_TOKEN = "eyJhbGciOiJIUzI1NiJ9.test-token";

function makeChallengeXdr(publicKey: string): string {
  const tx = new TransactionBuilder(
    {
      accountId: () => publicKey,
      sequenceNumber: () => "1",
      incrementSequenceNumber: vi.fn(),
    } as any,
    { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }
  )
    .addOperation(
      Operation.manageData({
        name: `${ANCHOR_URL} auth`,
        value: Buffer.from("000000000000000000000000", "hex"),
        source: publicKey,
      })
    )
    .setTimeout(300)
    .build();

  return tx.toEnvelope().toXDR("base64");
}

describe("StellarIdentityTool", () => {
  let tool: StellarIdentityTool;
  let publicKey: string;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    tool = new StellarIdentityTool(TEST_SECRET);
    publicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
  });

  it("completes SEP-0010 challenge-response and returns JWT", async () => {
    const challengeXdr = makeChallengeXdr(publicKey);

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transaction: challengeXdr,
          network_passphrase: Networks.TESTNET,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: JWT_TOKEN }),
      } as Response);

    const result = await tool.execute({ anchorUrl: ANCHOR_URL });

    expect(result.token).toBe(JWT_TOKEN);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      `${ANCHOR_URL}/auth?account=${encodeURIComponent(publicKey)}`
    );
    expect(fetch).toHaveBeenNthCalledWith(2, `${ANCHOR_URL}/auth`, expect.objectContaining({
      method: "POST",
    }));
  });

  it("getChallenge fetches challenge from anchor", async () => {
    const challengeXdr = makeChallengeXdr(publicKey);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        transaction: challengeXdr,
        network_passphrase: Networks.TESTNET,
      }),
    } as Response);

    const challenge = await tool.getChallenge(ANCHOR_URL, publicKey);
    expect(challenge.transaction).toBe(challengeXdr);
    expect(challenge.networkPassphrase).toBe(Networks.TESTNET);
  });

  it("does not log the JWT token", async () => {
    const challengeXdr = makeChallengeXdr(publicKey);

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          transaction: challengeXdr,
          network_passphrase: Networks.TESTNET,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: JWT_TOKEN }),
      } as Response);

    await tool.execute({ anchorUrl: ANCHOR_URL });

    for (const call of mockInfo.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(JWT_TOKEN);
    }
  });

  it("propagates challenge HTTP errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401 } as Response);
    await expect(tool.execute({ anchorUrl: ANCHOR_URL })).rejects.toThrow(
      "SEP-0010 challenge request failed"
    );
  });
});
