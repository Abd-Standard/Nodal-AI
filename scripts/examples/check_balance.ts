/**
 * scripts/examples/check_balance.ts
 *
 * Demonstrates a `balance_check` task — query asset balances for a Stellar account
 * via Horizon and pretty-print the results.
 *
 * This is the simplest tool to demonstrate and serves as a great entry point
 * for new contributors learning the agent API.
 *
 * Usage:
 *   npx ts-node scripts/examples/check_balance.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 */

import * as dotenv from "dotenv";
dotenv.config();

import { PayFiAgent } from "../../backend/agent";

const ACCOUNT_ID = process.env.AGENT_PUBLIC_KEY || process.env.ACCOUNT_ID;

if (!ACCOUNT_ID) {
  console.error("Error: AGENT_PUBLIC_KEY or ACCOUNT_ID environment variable is required");
  process.exit(1);
}

const agent = new PayFiAgent();

const result = await agent.run({
  type: "balance_check",
  payload: {
    publicKey: ACCOUNT_ID,
  },
});

// Pretty-print the returned balances
console.log(`\n📊 Balances for account: ${result.publicKey}\n`);
console.log("─".repeat(80));

if (result.balances && result.balances.length > 0) {
  result.balances.forEach((balance) => {
    const assetLabel =
      balance.assetType === "native"
        ? "XLM"
        : `${balance.assetCode} (${balance.assetIssuer})`;
    console.log(`  ${assetLabel.padEnd(60)} ${balance.balance.padStart(18)}`);
  });
} else {
  console.log("  No balances found for this account");
}

console.log("─".repeat(80));
console.log("");

agent.destroy();
