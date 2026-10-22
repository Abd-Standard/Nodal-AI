import { describe, it, expect, vi } from 'vitest';
import CircuitBreaker from 'opossum';

// rpc_client imports config at module load, and loadConfig() calls
// process.exit(1) when required env vars are absent — so importing the module
// under test would kill the run before a single assertion. Mocked with valid
// values; the breaker logic under test never touches the network.
vi.mock('../backend/config', () => ({
  config: {
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK: 'testnet',
    MAX_RETRIES: 1,
    RETRY_DELAY_MS: 1,
  },
}));

// attachBreakerTelemetry logs through the module-level `log` (a
// createLogger("rpc-client") child logger) in backend/rpc_client.ts. Mock
// utils/logger the same way tests/rpc_client.test.ts does, so `createLogger`
// always hands back this one shared mock and its warn/info calls can be
// asserted directly (#453).
const { rpcClientLog } = vi.hoisted(() => ({
  rpcClientLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../backend/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn(() => rpcClientLog),
  generateCorrelationId: vi.fn(() => 'mock-id'),
}));

import {
  createRpcBreaker,
  attachBreakerTelemetry,
  RPC_BREAKER_OPTIONS,
} from '../backend/rpc_client';

/**
 * Issue #244 — circuit breaker behaviour.
 *
 * The breaker was wired up but never asserted, so a misconfiguration would
 * fail silently: the circuit simply never opening looks identical to a healthy
 * dependency until the outage that needed it.
 *
 * Tests build their own breaker over a controlled action rather than driving
 * the exported RPC breakers, which would require a live network.
 */

/** Trip the breaker by exceeding volumeThreshold with 100% failures. */
async function driveToOpen(breaker: CircuitBreaker<unknown[], unknown>) {
  for (let i = 0; i < RPC_BREAKER_OPTIONS.volumeThreshold + 1; i++) {
    await breaker.fire().catch(() => undefined);
  }
}

describe('RPC circuit breaker', () => {
  it('uses thresholds that can actually trip', () => {
    // A volumeThreshold at or below zero, or a 100% error threshold, would
    // mean the breaker never opens in practice.
    expect(RPC_BREAKER_OPTIONS.volumeThreshold).toBeGreaterThan(0);
    expect(RPC_BREAKER_OPTIONS.errorThresholdPercentage).toBeGreaterThan(0);
    expect(RPC_BREAKER_OPTIONS.errorThresholdPercentage).toBeLessThanOrEqual(100);
    expect(RPC_BREAKER_OPTIONS.resetTimeout).toBeGreaterThan(0);
  });

  it('opens after the failure threshold is exceeded', async () => {
    const breaker = createRpcBreaker('test-open', async () => {
      throw new Error('upstream down');
    });

    expect(breaker.opened).toBe(false);
    await driveToOpen(breaker as unknown as CircuitBreaker<unknown[], unknown>);
    expect(breaker.opened).toBe(true);

    breaker.shutdown();
  });

  it('rejects immediately while open instead of calling through', async () => {
    let calls = 0;
    const breaker = createRpcBreaker('test-shortcircuit', async () => {
      calls++;
      throw new Error('upstream down');
    });

    await driveToOpen(breaker as unknown as CircuitBreaker<unknown[], unknown>);
    const callsWhenOpened = calls;

    await breaker.fire().catch(() => undefined);

    // The point of the breaker: further calls are short-circuited, so the
    // failing dependency stops being hammered.
    expect(calls).toBe(callsWhenOpened);

    breaker.shutdown();
  });

  it('transitions to half-open after resetTimeout', async () => {
    vi.useFakeTimers();
    try {
      const breaker = createRpcBreaker('test-halfopen', async () => {
        throw new Error('upstream down');
      });

      await driveToOpen(breaker as unknown as CircuitBreaker<unknown[], unknown>);
      expect(breaker.opened).toBe(true);

      vi.advanceTimersByTime(RPC_BREAKER_OPTIONS.resetTimeout + 1);

      expect(breaker.halfOpen).toBe(true);
      breaker.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on a successful call in the half-open state', async () => {
    vi.useFakeTimers();
    let shouldFail = true;
    try {
      const breaker = createRpcBreaker('test-close', async () => {
        if (shouldFail) throw new Error('upstream down');
        return 'ok';
      });

      await driveToOpen(breaker as unknown as CircuitBreaker<unknown[], unknown>);
      vi.advanceTimersByTime(RPC_BREAKER_OPTIONS.resetTimeout + 1);
      expect(breaker.halfOpen).toBe(true);

      shouldFail = false;
      vi.useRealTimers();
      await expect(breaker.fire()).resolves.toBe('ok');

      // Recovery must actually close the circuit, or traffic never resumes.
      expect(breaker.closed).toBe(true);
      breaker.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits open, halfOpen and close events for telemetry', async () => {
    vi.useFakeTimers();
    let shouldFail = true;
    try {
      const breaker = new CircuitBreaker(
        async () => {
          if (shouldFail) throw new Error('upstream down');
          return 'ok';
        },
        { ...RPC_BREAKER_OPTIONS, name: 'test-telemetry' }
      );
      attachBreakerTelemetry(breaker, 'test-telemetry');

      const seen: string[] = [];
      breaker.on('open', () => seen.push('open'));
      breaker.on('halfOpen', () => seen.push('halfOpen'));
      breaker.on('close', () => seen.push('close'));

      await driveToOpen(breaker as unknown as CircuitBreaker<unknown[], unknown>);
      expect(seen).toContain('open');

      vi.advanceTimersByTime(RPC_BREAKER_OPTIONS.resetTimeout + 1);
      expect(seen).toContain('halfOpen');

      shouldFail = false;
      vi.useRealTimers();
      await breaker.fire();
      expect(seen).toContain('close');

      breaker.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  // #453 — assert the actual log fields attachBreakerTelemetry emits on each
  // state change, so a regression there (wrong field name, dropped circuit
  // name, etc.) fails a test instead of only showing up in production logs.
  it('logs structured warn/info telemetry with the correct fields on each state change', async () => {
    vi.useFakeTimers();
    let shouldFail = true;
    try {
      const breaker = new CircuitBreaker(
        async () => {
          if (shouldFail) throw new Error('upstream down');
          return 'ok';
        },
        { ...RPC_BREAKER_OPTIONS, name: 'test-breaker' }
      );
      attachBreakerTelemetry(breaker, 'test-breaker');

      await driveToOpen(breaker as unknown as CircuitBreaker<unknown[], unknown>);

      expect(rpcClientLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          circuit: 'test-breaker',
          failures: expect.any(Number),
        }),
        'RPC circuit opened'
      );

      vi.advanceTimersByTime(RPC_BREAKER_OPTIONS.resetTimeout + 1);
      expect(breaker.halfOpen).toBe(true);

      expect(rpcClientLog.info).toHaveBeenCalledWith(
        { circuit: 'test-breaker' },
        'RPC circuit half-open'
      );

      shouldFail = false;
      vi.useRealTimers();
      await breaker.fire();
      expect(breaker.closed).toBe(true);

      expect(rpcClientLog.info).toHaveBeenCalledWith(
        expect.objectContaining({ circuit: 'test-breaker' }),
        'RPC circuit closed'
      );

      breaker.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});
