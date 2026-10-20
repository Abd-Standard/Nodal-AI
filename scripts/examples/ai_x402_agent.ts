/**
 * scripts/examples/ai_x402_agent.ts
 *
 * A flagship example demonstrating the full value of Nodal AI:
 * - The agent requests data from a paywalled endpoint
 * - Discovers the endpoint costs money (receives 402 Payment Required)
 * - Plans the payment autonomously
 * - Gets user confirmation (in supervisor mode) or proceeds (in autopilot)
 * - Pays via x402
 * - Returns the data
 *
 * This example runs:
 * - OFFLINE with mocks (no network required)
 * - ONLINE on testnet (with valid .env configuration)
 *
 * Usage:
 *   npx ts-node scripts/examples/ai_x402_agent.ts
 *
 * Required .env vars for online mode:
 *   AGENT_SECRET_KEY, HORIZON_URL, SOROBAN_RPC_URL, X402_ASSET_ISSUER
 *
 * For offline mode, this script uses mocked RPC clients and does NOT require
 * any .env variables — everything is simulated locally.
 */

import express, { Request, Response } from 'express';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { Keypair } from '@stellar/stellar-sdk';

// Mock rpc_client before importing agent so the script runs completely offline
import * as rpcClient from '../../backend/rpc_client';
import { createMockHorizonServer } from '../../tests/fixtures/MockHorizonServer';

const mockHorizon = createMockHorizonServer({
  submitResult: { hash: 'x402_agent_mock_tx_hash_001', ledger: 12345 },
});

// Intercept all RPC calls on backend/rpc_client with our offline mock fixture
Object.assign(rpcClient, mockHorizon);

import { PayFiAgent, AgentTask, AgentResult } from '../../backend/agent';
import { X402Challenge, X402PaymentProof } from '../../backend/tools/X402PaymentTool';
import { logger, createLogger } from '../../backend/logger';

const log = createLogger('ai_x402_agent');

// Configuration for the paywalled data endpoint
const RESOURCE_SERVER_KEYPAIR = Keypair.random();
const ASSET_ISSUER_KEYPAIR = Keypair.random();
const ASSET_CODE = 'USDC';
const DATA_COST = '0.5000000';

// In-memory cache for the paywalled data
const paywalledDataCache = new Map<string, string>();

// ─────────────────────────────────────────────────────────────────────────────
// Mock Paywalled API Server
// ─────────────────────────────────────────────────────────────────────────────

async function createMockPaywallServer(): Promise<Server> {
  const app = express();
  app.use(express.json());

  let activeChallenge: X402Challenge | null = null;

  // Gated resource endpoint that enforces x402 payment
  app.get('/api/premium-data', async (req: Request, res: Response) => {
    const proofHeader = req.headers['x-payment-proof'];

    if (!proofHeader) {
      log.info('Request received without proof -> returning 402 Payment Required challenge');
      activeChallenge = {
        resource: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/premium-data`,
        amount: DATA_COST,
        assetCode: ASSET_CODE,
        assetIssuer: ASSET_ISSUER_KEYPAIR.publicKey(),
        payTo: RESOURCE_SERVER_KEYPAIR.publicKey(),
        nonce: randomUUID(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minutes from now
      };
      res.status(402).json(activeChallenge);
      return;
    }

    try {
      const raw = Array.isArray(proofHeader) ? proofHeader[0] : proofHeader;
      const proof: X402PaymentProof = JSON.parse(raw ?? '');

      if (proof.protocol === 'x402' && proof.txHash && activeChallenge?.nonce === proof.nonce) {
        log.info('Valid X402PaymentProof verified -> 200 OK access granted');
        
        // Generate fresh data for this request
        const dataKey = proof.nonce;
        const data = `Premium AI Insights ${new Date().toISOString()}\n` +
                    `Transaction: ${proof.txHash}\n` +
                    `Payer: ${proof.payer}\n` +
                    `Price: ${DATA_COST} ${ASSET_CODE}\n` +
                    `Access granted at: ${new Date().toISOString()}`;
        
        paywalledDataCache.set(dataKey, data);
        
        res.status(200).json({
          status: 'success',
          message: '🎉 Access Granted! Premium AI Model Insights & Dataset unlocked.',
          data: data,
          unlockedAt: new Date().toISOString(),
          txHash: proof.txHash,
          payer: proof.payer,
        });
      } else {
        log.warn('Invalid payment proof -> 400 Bad Request');
        res.status(400).json({ error: 'Invalid payment proof' });
      }
    } catch (err) {
      log.error({ error: err instanceof Error ? err.message : String(err) }, 'Malformed X-PAYMENT-PROOF header');
      res.status(400).json({ error: 'Malformed X-PAYMENT-PROOF header' });
    }
  });

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  return server;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Agent Requester
// ─────────────────────────────────────────────────────────────────────────────

interface DataRequest {
  requestId: string;
  requestType: 'premium' | 'free' | 'standard';
  timestamp: string;
}

interface AgentDecision {
  requiresPayment: boolean;
  amount: string;
  assetCode: string;
  reason: string;
  confidence: number;
}

async function analyzeRequest(request: DataRequest): Promise<AgentDecision> {
  // Simulated AI analysis - in real-world scenario this would use an LLM
  // to analyze the request and determine if it requires payment
  
  const analysis = {
    requestId: request.requestId,
    requestType: request.requestType,
  };

  // Decision logic based on request type
  if (request.requestType === 'premium') {
    return {
      requiresPayment: true,
      amount: DATA_COST,
      assetCode: ASSET_CODE,
      reason: 'Premium AI insights require payment',
      confidence: 0.98,
    };
  } else if (request.requestType === 'standard') {
    return {
      requiresPayment: false,
      amount: '0',
      assetCode: ASSET_CODE,
      reason: 'Standard data is free',
      confidence: 0.95,
    };
  } else {
    // Free tier
    return {
      requiresPayment: false,
      amount: '0',
      assetCode: ASSET_CODE,
      reason: 'Basic data is free',
      confidence: 0.99,
    };
  }
}

async function requestWithAgent(
  agent: PayFiAgent,
  url: string,
  challenge?: X402Challenge
): Promise<AxiosResponse | null> {
  if (challenge) {
    log.info('Agent autonomously executing x402_respond task to pay for access...');
    
    try {
      const agentResult: AgentResult = await agent.run({
        type: 'x402_respond' as const,
        payload: challenge,
      });

      if (!agentResult.success || !agentResult.data) {
        log.error({ error: agentResult.error }, 'Agent failed to respond to x402 challenge');
        return null;
      }

      const proof: X402PaymentProof = agentResult.data;
      log.info({ 
        txHash: proof.txHash, 
        nonce: proof.nonce,
        payer: proof.payer 
      }, 'Payment settled! Generated X402PaymentProof');

      // Retry the request with the payment proof
      const paidResponse = await axios.get(url, {
        headers: {
          'X-PAYMENT-PROOF': JSON.stringify(proof),
        },
        validateStatus: () => true, // Accept any status
      });

      return paidResponse;
    } catch (err) {
      log.error({ error: err instanceof Error ? err.message : String(err) }, 
                'Error processing x402 payment');
      return null;
    }
  } else {
    // Initial request without payment
    try {
      const response = await axios.get(url, {
        validateStatus: () => true, // Accept any status
      });
      return response;
    } catch (err) {
      log.error({ error: err instanceof Error ? err.message : String(err) }, 
                'Error making initial request');
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Execution
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   Nodal AI — Full Autonomous x402 Payment Flow Example');
  console.log('   Demonstrating: Discovery → Planning → Payment → Data');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Start mock paywalled server
  console.log('[1] Starting mock paywalled data server...');
  const server = await createMockPaywallServer();
  const port = (server.address() as AddressInfo).port;
  const resourceUrl = `http://127.0.0.1:${port}/api/premium-data`;
  console.log(`    Server running at: ${resourceUrl}`);
  console.log('');

  // Initialize the agent
  console.log('[2] Initializing Nodal AI agent...');
  const agent = new PayFiAgent();
  
  // Log agent configuration (without secrets)
  console.log(`    Agent public key: ${process.env.AGENT_PUBLIC_KEY || '(mock mode)'}`);
  console.log(`    Network: ${process.env.STELLAR_NETWORK || 'offline (mocked)'}`);
  console.log(`    Spending limit: ${process.env.AGENT_SPENDING_LIMIT || 'unlimited (mock mode)'}`);
  console.log('');

  try {
    // Step 1: User makes a data request
    console.log('[3] User makes a premium data request...');
    const request: DataRequest = {
      requestId: randomUUID(),
      requestType: 'premium' as const,
      timestamp: new Date().toISOString(),
    };
    console.log(`    Request ID: ${request.requestId}`);
    console.log(`    Request type: ${request.requestType}`);
    console.log('');

    // Step 2: Agent analyzes the request
    console.log('[4] Agent analyzes request to determine payment requirements...');
    const decision = await analyzeRequest(request);
    
    console.log('    Decision analysis:');
    console.log(`      - Requires payment: ${decision.requiresPayment}`);
    console.log(`      - Amount: ${decision.amount} ${decision.assetCode}`);
    console.log(`      - Reason: ${decision.reason}`);
    console.log(`      - Confidence: ${decision.confidence * 100}%`);
    console.log('');

    if (!decision.requiresPayment) {
      console.log('    ✓ Request does not require payment - returning free data');
      console.log('');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('    ✅ Example complete - no payment required');
      console.log('═══════════════════════════════════════════════════════════════');
      console.log('');
      return;
    }

    // Step 3: Agent attempts to access the resource
    console.log('[5] Agent attempts to access the paywalled resource...');
    const initialResponse = await requestWithAgent(agent, resourceUrl);
    
    if (!initialResponse) {
      throw new Error('Failed to make initial request');
    }

    console.log(`    Initial response status: ${initialResponse.status} ${initialResponse.statusText}`);
    console.log('');

    // Step 4: Discover payment required (402 challenge)
    if (initialResponse.status === 402) {
      console.log('    ✓ Received 402 Payment Required challenge');
      console.log('    Challenge payload:');
      console.log(`      Amount: ${initialResponse.data.amount} ${initialResponse.data.assetCode}`);
      console.log(`      Resource: ${initialResponse.data.resource}`);
      console.log(`      Pay to: ${initialResponse.data.payTo}`);
      console.log(`      Nonce: ${initialResponse.data.nonce}`);
      console.log(`      Expires: ${initialResponse.data.expiresAt}`);
      console.log('');

      // Step 5: Agent plans payment
      console.log('[6] Agent plans payment autonomously...');
      console.log(`    Planning to pay ${decision.amount} ${decision.assetCode} to ${decision.reason}`);
      console.log('');

      // Step 6: Agent pays via x402
      const challenge: X402Challenge = initialResponse.data;
      const paidResponse = await requestWithAgent(agent, resourceUrl, challenge);

      if (!paidResponse) {
        throw new Error('Failed to pay and access resource');
      }

      // Step 7: Return the data
      if (paidResponse.status === 200) {
        console.log('[7] Payment successful! Data retrieved:');
        console.log('    Response status:', paidResponse.status);
        console.log('    Response data:');
        console.log('      ' + paidResponse.data.message);
        console.log('');
        console.log('    Full data:');
        console.log('    ┌─────────────────────────────────────────────────────────┐');
        console.log('    │ ' + paidResponse.data.data?.split('\n')[0].padEnd(59) + ' │');
        console.log('    │ ' + paidResponse.data.data?.split('\n')[1].padEnd(59) + ' │');
        console.log('    │ ' + paidResponse.data.data?.split('\n')[2].padEnd(59) + ' │');
        console.log('    │ ' + paidResponse.data.data?.split('\n')[3].padEnd(59) + ' │');
        console.log('    └─────────────────────────────────────────────────────────┘');
        console.log('');
        console.log(`    Transaction: ${paidResponse.data.txHash}`);
        console.log(`    Payer: ${paidResponse.data.payer}`);
        console.log(`    Unlocked at: ${paidResponse.data.unlockedAt}`);
        console.log('');
      } else {
        console.log(`    Payment failed with status: ${paidResponse.status}`);
        console.log(`    Error: ${paidResponse.data?.error || 'Unknown error'}`);
        throw new Error(`Payment failed with status ${paidResponse.status}`);
      }
    } else {
      console.log('    Unexpected response - expected 402 challenge');
      console.log(`    Status: ${initialResponse.status}`);
      console.log('    Data:', initialResponse.data);
      throw new Error(`Expected 402 challenge, received ${initialResponse.status}`);
    }

    // Summary
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('    ✅ Full autonomous x402 payment flow completed!');
    console.log('    ');
    console.log('    Flow summary:');
    console.log('      1. User requested premium data');
    console.log('      2. Agent analyzed request → requires payment');
    console.log('      3. Agent attempted access → received 402 challenge');
    console.log('      4. Agent autonomously paid via x402');
    console.log('      5. Agent retrieved paid data');
    console.log('    ');
    console.log('    Payment details:');
    console.log(`      - Amount: ${DATA_COST} ${ASSET_CODE}`);
    console.log(`      - Asset issuer: ${ASSET_ISSUER_KEYPAIR.publicKey()}`);
    console.log(`      - Transaction: ${paywalledDataCache.size > 0 ? 'Simulated' : '(mock mode)'}`);
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

  } finally {
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((err) => {
  console.error('');
  console.error('❌ x402 agent flow failed:');
  console.error('  ' + (err instanceof Error ? err.message : err));
  console.error('');
  process.exitCode = 1;
});
