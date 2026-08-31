/**
 * scripts/examples/query_contract.ts
 *
 * Demonstrates a `soroban_query` task — read-only contract state query.
 * This example calls get_state on a deployed escrow contract without broadcasting.
 *
 * Usage:
 *   CONTRACT_ID=C... npx ts-node scripts/examples/query_contract.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 *   CONTRACT_ID - The Stellar contract ID to query (56-character strkey C… encoding)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';

const CONTRACT_ID = process.env.CONTRACT_ID;

if (!CONTRACT_ID) {
  console.error('Error: CONTRACT_ID environment variable is required');
  console.error('Usage: CONTRACT_ID=C... npx ts-node scripts/examples/query_contract.ts');
  process.exit(1);
}

const agent = new PayFiAgent();

const result = await agent.run({
  type: 'soroban_query',
  payload: {
    contractId: CONTRACT_ID,
    method: 'get_state',
    args: [],
  },
});

console.log(JSON.stringify(result, null, 2));

if (result.success && result.data) {
  console.log('\nSimulation result:');
  console.log(JSON.stringify(result.data, null, 2));
}

agent.destroy();
