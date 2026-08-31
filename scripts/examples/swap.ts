/**
 * scripts/examples/swap.ts
 *
 * Demonstrates a `swap` task — discover the best strict-send path and execute
 * an atomic XLM → USDC swap with a slippage guard.
 *
 * Usage:
 *   npx ts-node scripts/examples/swap.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';

const agent = new PayFiAgent();

const result = await agent.run({
  type: 'swap',
  payload: {
    sellAsset: { code: 'XLM' },
    buyAsset: {
      code: 'USDC',
      issuer:
        process.env.X402_ASSET_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    },
    sellAmount: '1.0000000',
    maxSlippagePct: 1,
  },
});

console.log(JSON.stringify(result, null, 2));
agent.destroy();
