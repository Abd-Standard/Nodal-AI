/**
 * scripts/examples/fee_bump.ts
 *
 * Demonstrates a `fee_bump` task — wrapping a transaction in a fee-bump envelope.
 * This is useful for sponsored retry flows where the agent pays fees on behalf
 * of a transaction signed by a different account.
 *
 * Usage:
 *   INNER_TX_XDR=AAAA... npx ts-node scripts/examples/fee_bump.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 *   INNER_TX_XDR - Base64-encoded XDR of the inner transaction to fee-bump
 *
 * Expected INNER_TX_XDR format:
 *   A base64-encoded Stellar transaction envelope XDR string.
 *   The inner transaction must be signed for the same network as the agent.
 *   Example: "AAAAAgAAAAB..." (base64 string)
 *
 * The fee-bump will use baseFeeMultiplier: 2 by default, doubling the inner
 * transaction's fee to ensure successful submission.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';

const INNER_TX_XDR = process.env.INNER_TX_XDR;

if (!INNER_TX_XDR) {
  console.error('Error: INNER_TX_XDR environment variable is required');
  console.error('Usage: INNER_TX_XDR=AAAA... npx ts-node scripts/examples/fee_bump.ts');
  console.error('\nExpected INNER_TX_XDR format:');
  console.error('  - Base64-encoded Stellar transaction envelope XDR string');
  console.error('  - The inner transaction must be signed for the same network as the agent');
  console.error("  - Example: 'AAAAAgAAAAB...' (base64 string)");
  process.exit(1);
}

const agent = new PayFiAgent();

const result = await agent.run({
  type: 'fee_bump',
  payload: {
    innerTxXdr: INNER_TX_XDR,
    baseFeeMultiplier: 2, // Double the inner transaction's fee
  },
});

console.log(JSON.stringify(result, null, 2));

if (result.success && result.data) {
  console.log('\nFee-bump transaction submitted:');
  console.log(`  Transaction Hash: ${(result.data as { txHash: string }).txHash}`);
  console.log(`  Ledger: ${(result.data as { ledger: number }).ledger}`);
}

agent.destroy();
