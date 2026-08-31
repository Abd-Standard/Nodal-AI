/**
 * scripts/examples/respond_x402.ts
 *
 * Demonstrates an `x402_respond` task — respond to a sample x402 challenge
 * and print the resulting payment proof.
 *
 * Usage:
 *   npx ts-node scripts/examples/respond_x402.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';

const agent = new PayFiAgent();

// Sample x402 challenge — replace fields with a real challenge from a resource server.
const sampleChallenge = {
  resource: 'https://api.example.com/premium-data',
  amount: '0.5000000',
  assetCode: 'USDC',
  assetIssuer:
    process.env.X402_ASSET_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  nonce: '550e8400-e29b-41d4-a716-446655440000',
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minutes from now
};

const result = await agent.run({
  type: 'x402_respond',
  payload: sampleChallenge,
});

console.log(JSON.stringify(result, null, 2));
agent.destroy();
