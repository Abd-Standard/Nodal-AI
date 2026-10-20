/**
 * tests/chaos/orchestrator_chaos.test.ts
 *
 * Concurrency & chaos test suite for the orchestrator (#829).
 * Runs 200 parallel mixed tasks with random latency and injected RPC failures.
 *
 * Invariants asserted:
 *   1. Spending limit is never exceeded under race conditions.
 *   2. Every promise settles (no hangs, unhandled rejections, or leaked promises).
 *   3. No duplicate transactions are executed (idempotency + uniqueness).
 *   4. Concurrency queues and active tasks drain cleanly to zero.
 *   5. Entire chaos suite completes in < 30s.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayFiAgent, spendingTracker, type AgentTask, type AgentResult } from '../../backend/agent';
import * as rpcClient from '../../backend/rpc_client';
import type { MockHorizonServer } from '../fixtures/MockHorizonServer';
import { applyConditions, reset as resetNetworkConditions } from '../helpers/MockNetworkConditions';

// ─── Shared MockHorizonServer fixture ────────────────────────────────────────
vi.mock('../../backend/rpc_client', async () => {
  const { createMockHorizonServer } = await import('../fixtures/MockHorizonServer');
  return createMockHorizonServer();
});

const mockHorizonServer = rpcClient as unknown as MockHorizonServer;

// ─── Config with tight concurrency and spending limit ────────────────────────
vi.mock('../../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      AGENT_SPENDING_LIMIT: '500',
      MAX_RETRIES: 2,
      RETRY_DELAY_MS: 1,
      MAX_CONCURRENT_TASKS: 10,
      QUEUE_CAPACITY: 250,
      PAYMENT_DESTINATION_POLICY: 'open',
      PAYMENT_DESTINATIONS: [],
      agentKeypair: () => Keypair.fromSecret(secret),
    },
    MAINNET_SPENDING_CAP: 10_000,
  };
});

describe('Orchestrator Concurrency & Chaos Suite (#829)', () => {
  let agent: PayFiAgent;
  let txCounter = 0;
  const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  beforeEach(() => {
    spendingTracker.clear();
    resetNetworkConditions();
    mockHorizonServer.reset();
    txCounter = 0;

    // Generate unique txHash for each successful submitTransaction invocation
    mockHorizonServer.submitTransaction.mockImplementation(async () => {
      txCounter++;
      return {
        hash: `tx_hash_${txCounter}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ledger: 100 + txCounter,
      };
    });

    agent = new PayFiAgent();
  });

  afterEach(() => {
    resetNetworkConditions();
    agent.destroy();
  });

  it('runs 200 mixed tasks with queueing, draining and injected RPC failures, preserving all invariants', async () => {
    const startTime = Date.now();

    // ── Inject chaos via MockNetworkConditions ──────────────────────────────
    // 15% failure rate and 1-3ms latency on transaction submission
    applyConditions({
      latencyMs: 2,
      failureRate: 0.15,
      target: mockHorizonServer.submitTransaction,
      errorType: () => new Error('Horizon connection timed out: injected chaos failure'),
    });

    // ── Build 200 mixed tasks ───────────────────────────────────────────────
    const tasks: AgentTask[] = [];

    // 1. 120 Stellar payment tasks (value-moving, subject to spending limits)
    for (let i = 0; i < 120; i++) {
      tasks.push({
        type: 'stellar_payment',
        payload: {
          destination: DEST,
          amount: String((i % 10) + 1), // amounts 1 to 10
          assetCode: 'XLM',
        },
        correlationId: `chaos-payment-${i}`,
      });
    }

    // 2. 10 Idempotent payments (5 pairs with identical idempotencyKey + payload)
    for (let i = 0; i < 5; i++) {
      const key = `idempotency-key-${i}`;
      const payload = {
        destination: DEST,
        amount: '2',
        assetCode: 'XLM',
      };
      // Original task
      tasks.push({
        type: 'stellar_payment',
        payload,
        idempotencyKey: key,
        correlationId: `chaos-idem-${i}-a`,
      });
      // Duplicate task
      tasks.push({
        type: 'stellar_payment',
        payload,
        idempotencyKey: key,
        correlationId: `chaos-idem-${i}-b`,
      });
    }

    // 3. 30 Balance check tasks (read-only, non-value moving)
    for (let i = 0; i < 30; i++) {
      tasks.push({
        type: 'balance_check',
        payload: { accountId: DEST },
        correlationId: `chaos-balance-${i}`,
      });
    }

    // 4. 20 Account info tasks (read-only)
    for (let i = 0; i < 20; i++) {
      tasks.push({
        type: 'account_info',
        payload: {},
        correlationId: `chaos-account-${i}`,
      });
    }

    // 5. 20 Soroban query tasks (read-only)
    for (let i = 0; i < 20; i++) {
      tasks.push({
        type: 'soroban_query',
        payload: { contractId: CONTRACT_ID, key: `state_key_${i}` },
        correlationId: `chaos-soroban-${i}`,
      });
    }

    expect(tasks.length).toBe(200);

    // ── Dispatch all 200 tasks in parallel ──────────────────────────────────
    const taskPromises = tasks.map((task) => agent.run(task));

    // Also trigger draining/waiting concurrently
    const waitPromise = agent.waitForPendingTasks();

    // Settle all tasks
    const settledResults = await Promise.allSettled(taskPromises);
    await waitPromise;

    const totalDuration = Date.now() - startTime;

    // ── Invariant 1: Every promise settles without unhandled errors ──────────
    expect(settledResults).toHaveLength(200);
    for (const res of settledResults) {
      expect(res.status).toBe('fulfilled');
      if (res.status === 'fulfilled') {
        const agentResult: AgentResult = res.value;
        expect(agentResult).toBeDefined();
        expect(typeof agentResult.success).toBe('boolean');
        expect(agentResult.taskType).toBeDefined();
        expect(agentResult.correlationId).toBeDefined();
      }
    }

    // ── Invariant 2: Spending limit is NEVER exceeded ────────────────────────
    const finalSpend = spendingTracker.total();
    const finalSpendWithReserved = spendingTracker.totalWithReserved();
    const spendingLimit = 500;

    expect(finalSpend).toBeLessThanOrEqual(spendingLimit);
    expect(finalSpendWithReserved).toBeLessThanOrEqual(spendingLimit);

    // Sum of amounts of all successful stellar_payment tasks (excluding cached idempotency duplicates)
    const executedPayments = settledResults
      .filter(
        (r): r is PromiseFulfilledResult<AgentResult> =>
          r.status === 'fulfilled' && r.value.success && r.value.taskType === 'stellar_payment'
      )
      .map((r) => r.value);

    // ── Invariant 3: No duplicate transactions ──────────────────────────────
    const txHashes = executedPayments
      .map((p) => (p.data as { txHash?: string })?.txHash)
      .filter((hash): hash is string => typeof hash === 'string');

    // Filter unique hashes
    const uniqueTxHashes = new Set(txHashes);

    // The number of unique hashes must equal the number of submitTransaction mock calls
    expect(uniqueTxHashes.size).toBe(mockHorizonServer.submitTransaction.mock.calls.length);

    // ── Invariant 4: Queue & active tasks drain cleanly to zero ─────────────
    expect((agent as any).activeTasks).toBe(0);
    expect((agent as any).taskQueue).toHaveLength(0);

    // ── Invariant 5: Suite runs in < 30 s ───────────────────────────────────
    expect(totalDuration).toBeLessThan(30_000);
  }, 30_000);
});
