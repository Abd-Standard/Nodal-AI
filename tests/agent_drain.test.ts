/**
 * tests/agent_drain.test.ts
 *
 * drain() must settle queued tasks, and waitForPendingTasks() must be bounded,
 * so a shutdown never leaves callers hanging (issue #751).
 *
 * The concurrency slot is held by setting `activeTasks` directly, which makes
 * run() queue without needing a tool that blocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayFiAgent, AgentTask } from '../backend/agent';
import { ErrorType } from '../backend/errors';

vi.mock('../backend/persistence', () => ({
  saveResult: vi.fn(),
  loadRecentSpend: vi.fn().mockReturnValue(0),
}));

vi.mock('../backend/webhook', () => ({
  dispatchWebhook: vi.fn(),
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = Keypair.random().secret();
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      AGENT_SPENDING_LIMIT: '100',
      QUEUE_CAPACITY: 5,
      MAX_CONCURRENT_TASKS: 1,
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const task = { type: 'balance_check', params: {} } as unknown as AgentTask;

describe('PayFiAgent drain', () => {
  let agent: PayFiAgent;
  const slots = () => agent as unknown as { activeTasks: number; taskQueue: unknown[] };

  beforeEach(() => {
    agent = new PayFiAgent();
  });

  afterEach(() => {
    vi.useRealTimers();
    agent.destroy();
  });

  it('settles queued tasks with AgentShuttingDown instead of leaving them pending', async () => {
    slots().activeTasks = 1;
    const queued = agent.run({ ...task, correlationId: 'queued-1' });
    expect(slots().taskQueue).toHaveLength(1);

    agent.drain();

    await expect(queued).resolves.toMatchObject({
      success: false,
      errorType: ErrorType.AgentShuttingDown,
      correlationId: 'queued-1',
    });
    expect(slots().taskQueue).toHaveLength(0);
  });

  it('waitForPendingTasks returns false once the timeout elapses', async () => {
    vi.useFakeTimers();
    slots().activeTasks = 1;

    const waiting = agent.waitForPendingTasks(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(waiting).resolves.toBe(false);
  });

  it('waitForPendingTasks returns true when in-flight work finishes in time', async () => {
    vi.useFakeTimers();
    slots().activeTasks = 1;

    const waiting = agent.waitForPendingTasks(1_000);
    slots().activeTasks = 0;
    await vi.advanceTimersByTimeAsync(100);

    await expect(waiting).resolves.toBe(true);
  });
});
