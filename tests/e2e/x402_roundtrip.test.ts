/**
 * tests/e2e/x402_roundtrip.test.ts
 *
 * End-to-end test: full x402 round-trip against Stellar testnet.
 *
 * Funds a resource-server testnet account and an asset-issuer testnet
 * account, has the agent trust and receive the issued asset, dispatches an
 * `x402_respond` task through `PayFiAgent.run()` against a challenge payable
 * to the resource server, then verifies the returned proof against the
 * settled transaction on Horizon via `X402PaymentTool.verify()`.
 *
 * A custom (non-native) asset is used deliberately: Horizon payment
 * operation records omit `asset_code` for native XLM payments, which would
 * make the asset-match check in `verify()` unrepresentative of the real
 * (non-native) x402 payment flow this protocol targets.
 *
 * This catches any divergence between respond()'s memo derivation and
 * verify()'s memo checking that a mocked unit test would miss.
 *
 * Run with:  npm run test:e2e
 * Excluded from default `npm run test` (see vitest.config.ts).
 *
 * Prerequisites:
 *   - AGENT_SECRET_KEY (and related config) set for a funded testnet account
 *   - Network access to Friendbot and Horizon testnet
 *   - ALLOWED_X402_ORIGINS unset, or including "api.example.com"
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk";
import { randomUUID } from "crypto";
import * as http from "http";
import type { AddressInfo } from "net";
import axios from "axios";
import { PayFiAgent } from "../../backend/agent";
import { X402PaymentTool, X402Challenge } from "../../backend/tools/X402PaymentTool";
import { config } from "../../backend/config";

const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const ASSET_CODE = "E2EUSD";

const horizon = new Horizon.Server(HORIZON_URL, { allowHttp: false });

async function friendbot(address: string): Promise<void> {
  await axios.get(`https://friendbot.stellar.org?addr=${address}`);
}

describe("x402 round-trip E2E — testnet", () => {
  let resourceServerKp: Keypair;
  let issuerKp: Keypair;
  let agent: PayFiAgent;
  let asset: Asset;

  beforeAll(async () => {
    resourceServerKp = Keypair.random();
    issuerKp = Keypair.random();
    asset = new Asset(ASSET_CODE, issuerKp.publicKey());

    await Promise.all([
      friendbot(resourceServerKp.publicKey()),
      friendbot(issuerKp.publicKey()),
    ]);
    // Small pause to let Horizon index the funded accounts
    await new Promise((r) => setTimeout(r, 5000));

    agent = new PayFiAgent();

    // Resource server trusts the asset so it can receive the settlement payment
    const resourceAccount = await horizon.loadAccount(resourceServerKp.publicKey());
    const trustTx = new TransactionBuilder(resourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(30)
      .build();
    trustTx.sign(resourceServerKp);
    await horizon.submitTransaction(trustTx);

    // Agent trusts the asset so it can hold and pay it out
    const agentAccount = await horizon.loadAccount(config.AGENT_PUBLIC_KEY);
    const agentTrustTx = new TransactionBuilder(agentAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(30)
      .build();
    agentTrustTx.sign(config.agentKeypair());
    await horizon.submitTransaction(agentTrustTx);

    // Issuer funds the agent with enough of the asset to pay the challenge
    const issuerAccount = await horizon.loadAccount(issuerKp.publicKey());
    const fundAgentTx = new TransactionBuilder(issuerAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({ destination: config.AGENT_PUBLIC_KEY, asset, amount: "100" })
      )
      .setTimeout(30)
      .build();
    fundAgentTx.sign(issuerKp);
    await horizon.submitTransaction(fundAgentTx);
  }, 90_000);

  it("respond()s to a challenge then verify()s the settled payment", async () => {
    const challenge: X402Challenge = {
      resource: "https://api.example.com/data",
      amount: "1.0000000",
      assetCode: ASSET_CODE,
      assetIssuer: issuerKp.publicKey(),
      payTo: resourceServerKp.publicKey(),
      nonce: randomUUID(),
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };

    const result = await agent.run({ type: "x402_respond", payload: challenge });

    expect(result.success).toBe(true);

    const verifier = new X402PaymentTool();
    await expect(verifier.verify(result.data as any, challenge)).resolves.not.toThrow();
  }, 60_000);

  // #452 — the tests above only ever exercise the *client* half of x402
  // (agent.run() called directly with a challenge object). This drives the
  // full HTTP round trip against a local mock resource server that plays the
  // other half of the protocol: it issues the 402 challenge, then accepts or
  // rejects the follow-up request based on the proof header.
  //
  // Gated on RUN_E2E in addition to the file's existing testnet
  // prerequisites, since it reuses the funded agent/asset from beforeAll and
  // still needs Friendbot/Horizon network access.
  describe.skipIf(!process.env.RUN_E2E)("mock resource server round trip", () => {
    it("receives a 402 challenge, pays it, and gets 200 back with a valid proof", async () => {
      const challenge: X402Challenge = {
        resource: "", // filled in below once the mock server has a port
        amount: "1.0000000",
        assetCode: ASSET_CODE,
        assetIssuer: issuerKp.publicKey(),
        payTo: resourceServerKp.publicKey(),
        nonce: randomUUID(),
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };

      const server = http.createServer((req, res) => {
        if (req.url !== "/resource") {
          res.writeHead(404);
          res.end();
          return;
        }

        const proofHeader = req.headers["x-payment-proof"];
        if (!proofHeader) {
          res.writeHead(402, { "Content-Type": "application/json" });
          res.end(JSON.stringify(challenge));
          return;
        }

        try {
          const raw = Array.isArray(proofHeader) ? proofHeader[0] : proofHeader;
          const proof = JSON.parse(raw ?? "");
          if (typeof proof.txHash === "string" && proof.txHash.length > 0) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing txHash" }));
          }
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid proof" }));
        }
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

      try {
        const port = (server.address() as AddressInfo).port;
        const resourceUrl = `http://127.0.0.1:${port}/resource`;
        challenge.resource = resourceUrl;

        // 1. Agent hits the gated endpoint and gets a 402 challenge back.
        const challengeResponse = await axios.get(resourceUrl, {
          validateStatus: () => true,
        });
        expect(challengeResponse.status).toBe(402);
        const receivedChallenge: X402Challenge = challengeResponse.data;

        // 2. Agent pays the challenge via x402_respond and gets a signed proof.
        const result = await agent.run({
          type: "x402_respond",
          payload: receivedChallenge,
        });
        expect(result.success).toBe(true);

        // 3. Agent retries the request, attaching the proof — server verifies
        // txHash is non-empty and grants access.
        const paidResponse = await axios.get(resourceUrl, {
          headers: { "X-PAYMENT-PROOF": JSON.stringify(result.data) },
          validateStatus: () => true,
        });
        expect(paidResponse.status).toBe(200);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 60_000);
  });
});
