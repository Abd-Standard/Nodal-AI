/**
 * scripts/examples/invoke_escrow.ts
 *
 * Demonstrates a `soroban_invoke` task — call `get_state` on a deployed
 * escrow contract and print the result.
 *
 * Usage:
 *   CONTRACT_ID=<56-char-C-address> npx ts-node scripts/examples/invoke_escrow.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';

const CONTRACT_ID =
  process.env.CONTRACT_ID ?? 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

const agent = new PayFiAgent();

const result = await agent.run({
  type: 'soroban_invoke',
  payload: {
    contractId: CONTRACT_ID,
    method: 'get_state',
    args: [],
    simulateOnly: true,
  },
});

console.log(JSON.stringify(result, null, 2));
agent.destroy();
