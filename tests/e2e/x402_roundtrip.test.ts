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
});
