/**
 * scripts/examples/place_dex_offer.ts
 *
 * Demonstrates a `dex_offer` task — place a DEX offer on the Stellar network.
 * This example creates a manage-sell offer to trade XLM for USDC.
 *
 * Usage:
 *   npx ts-node scripts/examples/place_dex_offer.ts
 *
 * Required .env vars:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { PayFiAgent } from '../../backend/agent';

const agent = new PayFiAgent();

// Create a DEX offer: sell XLM at a specific price for USDC
const result = await agent.run({
  type: 'dex_offer',
  payload: {
    action: 'create',
    selling: {
      code: 'XLM',
      // issuer is omitted for native XLM
    },
    buying: {
      code: 'USDC',
      issuer:
        process.env.X402_ASSET_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    },
    amount: '100.0000000', // Selling 100 XLM
    price: '0.50', // At 0.50 USDC per XLM (example rate)
  },
});

console.log('DEX Offer Result:');
console.log(JSON.stringify(result, null, 2));

if (result.success) {
  console.log('\nOffer placed successfully!');
  console.log(`Transaction Hash: ${result.data?.txHash}`);
  console.log(`Offer ID: ${result.data?.offerId}`);
  console.log(`Ledger: ${result.data?.ledger}`);
} else {
  console.error('\nFailed to place DEX offer:', result.error);
}

agent.destroy();
