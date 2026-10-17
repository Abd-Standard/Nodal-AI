/**
 * scripts/examples/check_balance.ts
 *
 * Demonstrates an `account_info` task — query all asset balances for the agent's
 * Stellar account via Horizon and pretty-print the results.
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

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';
import type { AccountInfo } from '../../backend/tools/AccountInfoTool';

async function main() {
  const agent = new PayFiAgent();

  // `balance_check` returns a single asset balance string; `account_info`
  // returns the agent account's full balance list as AccountInfo.
  const result = await agent.run({ type: 'account_info', payload: {} });

  if (!result.success) {
    console.error(`Error: ${result.error}`);
    agent.destroy();
    process.exit(1);
  }

  const info = result.data as AccountInfo;

  // Pretty-print the returned balances
  console.log(`\n📊 Balances for account: ${info.publicKey}\n`);
  console.log('─'.repeat(80));

  if (info.balances.length > 0) {
    info.balances.forEach(({ asset, balance }) => {
      console.log(`  ${asset.padEnd(60)} ${balance.padStart(18)}`);
    });
  } else {
    console.log('  No balances found for this account');
  }

  console.log('─'.repeat(80));
  console.log('');

  agent.destroy();
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
