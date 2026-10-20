/**
 * scripts/examples/x402_full_flow.ts
 *
 * Demonstrates the complete x402 v2 payment flow end-to-end using the
 * official @x402/stellar spec:
 *
 *   1. A local Express server gates `/resource` with `nodalPaywall()`.
 *   2. The agent calls `agent.fetchPaid(url)` which:
 *      a. Receives 402 + PAYMENT-REQUIRED header from the paywall.
 *      b. Selects a Stellar-compatible option from `accepts[]`.
 *      c. Signs the SAC auth entry via the agent's signer.
 *      d. Retries with the PAYMENT header.
 *      e. The facilitator verifies and settles on-chain.
 *   3. The server hands the 200 response through to the caller.
 *
 * Runs offline with a mock facilitator so no live network is required.
 *
 * Usage:
 *   npx ts-node scripts/examples/x402_full_flow.ts
 *
 * Required .env vars for live testnet mode (optional — offline works without them):
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER,
 *   X402_FACILITATOR_URL (e.g. https://x402.org/facilitator)
 */

import express from 'express';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Keypair } from '@stellar/stellar-sdk';

// ─── Offline mock facilitator ────────────────────────────────────────────────
//
// We intercept X402_FACILITATOR_URL so the script can run without a live
// facilitator.  The mock returns a successful SettleResponse and writes a fake
// PAYMENT-RESPONSE header so the resource server releases the 200.

process.env.STELLAR_NETWORK ??= 'testnet';
process.env.X402_FACILITATOR_URL ??= 'http://127.0.0.1:19402'; // started below

// ─── Mock rpc_client so the agent can sign without a live Soroban node ───────
import * as rpcClient from '../../backend/rpc_client';
import { createMockHorizonServer } from '../../tests/fixtures/MockHorizonServer';

const mockHorizon = createMockHorizonServer({
  submitResult: { hash: 'x402_v2_mock_tx_hash_001', ledger: 12345 },
});
Object.assign(rpcClient, mockHorizon);

// ─── Agent + middleware imports ───────────────────────────────────────────────
import { PayFiAgent } from '../../backend/agent';
import { nodalPaywall } from '../../backend/x402/middleware';

// ─── Start a tiny mock facilitator server ────────────────────────────────────
async function startMockFacilitator(port: number): Promise<Server> {
  const app = express();
  app.use(express.json());

  // /supported — what payment schemes are available
  app.get('/supported', (_req: Request, res: Response) => {
    res.json({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet' }],
      extensions: [],
    });
  });

  // /verify — always approves the payment
  app.post('/verify', (_req: Request, res: Response) => {
    res.json({ isValid: true, payer: Keypair.random().publicKey() });
  });

  // /settle — returns a successful settlement
  app.post('/settle', (_req: Request, res: Response) => {
    res.json({
      success: true,
      txHash: 'mock_settle_tx_' + randomUUID().replace(/-/g, '').slice(0, 16),
      network: 'stellar:testnet',
    });
  });

  return new Promise((resolve) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   Nodal AI — x402 v2 Full Payment Flow (official spec)');
  console.log('   nodalPaywall() seller  ×  agent.fetchPaid() buyer');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // ── 1. Start mock facilitator ─────────────────────────────────────────────
  const FACILITATOR_PORT = 19402;
  console.log('[1] Starting mock x402 facilitator...');
  const facilitatorServer = await startMockFacilitator(FACILITATOR_PORT);
  console.log(`    http://127.0.0.1:${FACILITATOR_PORT}  (mock: verify/settle always approve)\n`);

  // ── 2. Build the resource server using nodalPaywall ───────────────────────
  console.log('[2] Building gated resource server with nodalPaywall()...');
  const PAY_TO = Keypair.random().publicKey(); // merchant's receive address
  const app = express();
  app.use(express.json());

  app.get(
    '/resource',
    nodalPaywall({
      price: '0.01',
      asset: 'USDC',
      payTo: PAY_TO,
      facilitatorUrl: `http://127.0.0.1:${FACILITATOR_PORT}`,
      description: 'Access to premium market data',
    }),
    (_req: Request, res: Response) => {
      res.json({
        status: 'success',
        message: '🎉 Access Granted — Premium market data unlocked.',
        data: { price: 142_500, volume: 3_812_900, ts: new Date().toISOString() },
      });
    }
  );

  const resourceServer: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const resourcePort = (resourceServer.address() as AddressInfo).port;
  const resourceUrl = `http://127.0.0.1:${resourcePort}/resource`;
  console.log(`    GET ${resourceUrl}`);
  console.log(`    price: 0.01 USDC → payTo: ${PAY_TO.slice(0, 16)}…\n`);

  // ── 3. Initialise the agent ───────────────────────────────────────────────
  console.log('[3] Initialising Nodal AI agent...');
  const agent = new PayFiAgent();
  console.log('    Agent ready.\n');

  try {
    // ── 4. Unpaid probe — shows the 402 challenge ─────────────────────────
    console.log('[4] Probing resource without payment...');
    const { response: probeResp, settlement: probeSettlement } =
      await agent.fetchPaid(resourceUrl).catch(() =>
        // fetchPaid never throws on 402; but show raw 402 headers for demo
        fetch(resourceUrl).then((r) => ({ response: r, settlement: undefined }))
      );
    if (probeSettlement === undefined && !probeResp.ok) {
      const paymentRequired = probeResp.headers.get('PAYMENT-REQUIRED');
      if (paymentRequired) {
        const pr = JSON.parse(
          Buffer.from(paymentRequired, 'base64').toString('utf8')
        ) as { accepts?: { scheme: string; network: string; amount: string }[] };
        const first = pr.accepts?.[0];
        console.log(`    → 402 Payment Required`);
        if (first) {
          console.log(`      scheme:  ${first.scheme}`);
          console.log(`      network: ${first.network}`);
          console.log(`      amount:  ${first.amount}\n`);
        }
      } else {
        console.log(`    → ${probeResp.status} (no PAYMENT-REQUIRED header — check middleware)\n`);
      }
    }

    // ── 5. Paid request via agent.fetchPaid() ─────────────────────────────
    console.log('[5] Calling agent.fetchPaid() — signs auth entry, pays, retries...');
    const { response: paidResp, settlement } = await agent.fetchPaid(resourceUrl);

    console.log(`    Response status: ${paidResp.status} ${paidResp.statusText}`);
    if (settlement) {
      console.log(`    Settlement:      ${settlement.success ? '✓ success' : '✗ failed'}`);
      if ('txHash' in settlement && settlement.txHash) {
        console.log(`    TX hash:         ${settlement.txHash}`);
      }
    }
    const body = await paidResp.json();
    console.log('\n    Response body:');
    console.log('   ', JSON.stringify(body, null, 2).replace(/\n/g, '\n    '));

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('    ✅ x402 v2 full flow completed successfully!');
    console.log('');
    console.log('    What just happened:');
    console.log('    1. nodalPaywall() gated GET /resource behind 402');
    console.log('    2. agent.fetchPaid() read the PAYMENT-REQUIRED header');
    console.log('    3. ExactStellarScheme signed the SAC auth entry');
    console.log('    4. Mock facilitator verified + settled the payment');
    console.log('    5. Server released the protected 200 response');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');
  } finally {
    agent.destroy();
    await Promise.all([
      new Promise<void>((r) => resourceServer.close(() => r())),
      new Promise<void>((r) => facilitatorServer.close(() => r())),
    ]);
  }
}

main().catch((err) => {
  console.error('\n❌ x402 v2 flow failed:', err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
});
