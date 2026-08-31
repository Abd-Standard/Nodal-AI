/**
 * scripts/examples/send_xlm.ts
 *
 * Demonstrates a minimal `stellar_payment` task — send XLM to a recipient.
 *
 * Usage:
 *   npx ts-node scripts/examples/send_xlm.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';

const agent = new PayFiAgent();

const result = await agent.run({
  type: 'stellar_payment',
  payload: {
    destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    amount: '1.0000000',
    assetCode: 'XLM',
    memo: 'example payment',
  },
});

console.log(JSON.stringify(result, null, 2));
agent.destroy();
