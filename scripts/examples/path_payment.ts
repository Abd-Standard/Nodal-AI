/**
 * scripts/examples/path_payment.ts
 *
 * Demonstrates a `path_payment` task — send XLM while recipient receives USDC
 * via a cross-asset swap through Stellar's DEX.
 *
 * This showcases one of the most powerful PayFi primitives: enabling seamless
 * multi-asset transactions on the Stellar network.
 *
 * Usage:
 *   npx ts-node scripts/examples/path_payment.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';

const agent = new PayFiAgent();

const result = await agent.run({
  type: 'path_payment',
  payload: {
    destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    sendAsset: {
      code: 'XLM',
    },
    sendAmount: '1.0000000',
    destAsset: {
      code: 'USDC',
      issuer: 'GBUQWP3BOUZX34ULNQG23RQ6F4YUSXHTQSXUSMIQSTBE2EURIDVXL6B',
    },
    destMinAmount: '0.0000001',
    memo: 'cross-asset payment example',
  },
});

console.log(JSON.stringify(result, null, 2));
agent.destroy();
