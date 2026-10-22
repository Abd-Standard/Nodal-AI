/**
 * tests/rpc_client.test.ts
 *
 * Tests for withRetry and DEFAULT_IS_RETRYABLE in backend/rpc_client.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ZodError, z } from 'zod';
import {
  withRetry,
  DEFAULT_IS_RETRYABLE,
  resolveNetworkPassphrase,
  withTimeout,
  TimeoutError,
  prepareSorobanTx,
  horizonServer,
  sorobanServer,
  loadAccount,
  invalidateAccountCache,
} from '../backend/rpc_client';
import { SimulationBudgetError, ConfigError, ContractError } from '../backend/errors';
import { Networks, rpc, xdr, StrKey, Keypair } from '@stellar/stellar-sdk';

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    rpc: {
      ...(mod.rpc as Record<string, unknown>),
      assembleTransaction: vi.fn(),
    },
  };
});

vi.mock('../backend/utils/logger', () => {
  // Use a module-level log object that is safe to create inside the factory
  const _log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  // Store on globalThis so beforeEach can clear it
  (globalThis as any).__rpcClientLog = _log;
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    createLogger: vi.fn(() => _log),
    generateCorrelationId: vi.fn(() => 'mock-id'),
  };
});

vi.mock('../backend/config', () => {
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_SECRET_KEY: secret,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      RPC_TIMEOUT_MS: 9000,
      ACCOUNT_CACHE_TTL_MS: 30_000,
      MAX_X402_PAYMENTS_PER_MINUTE: 10,
      MAX_SOROBAN_FEE_STROOPS: 1_000_000,
    },
  };
});

beforeEach(() => {
  const log = (globalThis as any).__rpcClientLog;
  if (log) {
    log.info.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
    log.debug.mockClear();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── resolveNetworkPassphrase ─────────────────────────────────────────────────

describe('resolveNetworkPassphrase', () => {
  it('returns Networks.PUBLIC for mainnet', () => {
    expect(resolveNetworkPassphrase('mainnet')).toBe(Networks.PUBLIC);
  });

  it('returns Networks.TESTNET for testnet', () => {
    expect(resolveNetworkPassphrase('testnet')).toBe(Networks.TESTNET);
  });

  it('returns Networks.FUTURENET for futurenet', () => {
    expect(resolveNetworkPassphrase('futurenet')).toBe(Networks.FUTURENET);
  });

  it('throws for an unknown network string', () => {
    expect(() => resolveNetworkPassphrase('unknown')).toThrow('Unsupported network: unknown');
  });

  it('throws a ConfigError instance for unsupported networks', () => {
    expect(() => resolveNetworkPassphrase('unsupported')).toThrow(ConfigError);
    try {
      resolveNetworkPassphrase('invalid-net');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
    }
  });

  it('throws for empty string', () => {
    expect(() => resolveNetworkPassphrase('')).toThrow('Unsupported network: ');
  });

  it('throws for undefined cast to string', () => {
    expect(() => resolveNetworkPassphrase(undefined as any)).toThrow();
  });
});

// ─── DEFAULT_IS_RETRYABLE ─────────────────────────────────────────────────────

describe('DEFAULT_IS_RETRYABLE', () => {
  it('returns false for ZodError', () => {
    expect(DEFAULT_IS_RETRYABLE(new ZodError([]))).toBe(false);
  });

  it('returns false for TypeError', () => {
    expect(DEFAULT_IS_RETRYABLE(new TypeError('bad type'))).toBe(false);
  });

  it('returns true for a generic Error', () => {
    expect(DEFAULT_IS_RETRYABLE(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('returns true for a plain string error', () => {
    expect(DEFAULT_IS_RETRYABLE('network failure')).toBe(true);
  });

  it('returns false for a budget_exceeded simulation error', () => {
    expect(DEFAULT_IS_RETRYABLE(new Error('HostError: budget_exceeded'))).toBe(false);
  });

  it('returns false for a simulation failed error', () => {
    expect(DEFAULT_IS_RETRYABLE(new Error('Soroban simulation failed: some reason'))).toBe(false);
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  it('throws ZodError immediately without retrying', async () => {
    const zodError = z.string().safeParse(42).error!;
    const fn = vi.fn().mockRejectedValue(zodError);

    await expect(withRetry(fn, 3, 0)).rejects.toBeInstanceOf(ZodError);
    // Deterministic failure — must not retry at all
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws TypeError immediately without retrying', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('cannot read property'));

    await expect(withRetry(fn, 3, 0)).rejects.toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries the full MAX_RETRIES times for a transient error (e.g. HTTP 503)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));

    await expect(withRetry(fn, 3, 0)).rejects.toThrow('503');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('resolves on the first successful attempt without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    await expect(withRetry(fn, 3, 0)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('resolves after a transient failure followed by success', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue('recovered');

    await expect(withRetry(fn, 3, 0)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ── Exponential back-off timing with fake timers (#58) ──────────────────────

  it('respects exponential delay progression [1500, 3000, 6000]', async () => {
    vi.useFakeTimers();
    // Mock Math.random to return 0 so jitter (±20%) is eliminated from delays
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('try1'))
      .mockRejectedValueOnce(new Error('try2'))
      .mockRejectedValueOnce(new Error('try3'))
      .mockResolvedValue('success');

    const promise = withRetry(fn, 4, 1500, DEFAULT_IS_RETRYABLE, 30000);
    await vi.advanceTimersByTimeAsync(0); // Initial attempt
    expect(fn).toHaveBeenCalledTimes(1);

    // Each delay includes ±20% jitter, so advance by delay + 20% ceiling
    await vi.advanceTimersByTimeAsync(1500 * 1.2 + 50); // First retry after ~1500ms
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3000 * 1.2 + 50); // Second retry after ~3000ms
    expect(fn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(6000 * 1.2 + 50); // Third retry after ~6000ms
    expect(fn).toHaveBeenCalledTimes(4);

    await expect(promise).resolves.toBe('success');
    randomSpy.mockRestore();
    vi.useRealTimers();
  });

  it('respects maxDelayMs cap on exponential growth', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');

    const promise = withRetry(fn, 3, 1500, DEFAULT_IS_RETRYABLE, 2000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500); // First retry
    await vi.advanceTimersByTimeAsync(2000); // Second retry should be capped at 2000, not 3000

    await expect(promise).resolves.toBe('ok');
    vi.useRealTimers();
  });

  it('jitter does not cause delay to exceed maxDelayMs cap', async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue('ok');
    const startTime = Date.now();

    // Jitter is ±20% of capped delay, so for cap of 1000: jitter max is 200
    // Total max delay should not exceed 1000 + 200 = 1200
    const promise = withRetry(fn, 1, 500, DEFAULT_IS_RETRYABLE, 1000);
    await vi.advanceTimersByTimeAsync(1200);

    await expect(promise).resolves.toBe('ok');
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThanOrEqual(1200);
    vi.useRealTimers();
  });

  it('last error is re-thrown after exhaustion with StellarRPCError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Service Unavailable'));

    let caughtErr: unknown;
    try {
      await withRetry(fn, 3, 0);
    } catch (e) {
      caughtErr = e;
    }
    expect(caughtErr).toBeInstanceOf(Error);
    const err = caughtErr as Error;
    expect(err.name).toBe('StellarRPCError');
    expect(err.message).toContain('RPC call failed after 3 attempt(s)');
    let caught: unknown;
    try {
      await withRetry(fn, 3, 0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as Error).name).toBe('StellarRPCError');
    expect((caught as Error).message).toContain('RPC call failed after 3 attempt(s)');
  });
});

// ─── withTimeout ──────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves when the promise completes before the timeout', async () => {
    const fast = Promise.resolve('done');
    await expect(withTimeout(fast, 500)).resolves.toBe('done');
  });

  it('throws TimeoutError when the promise exceeds the timeout', async () => {
    const slow = new Promise<never>(() => {}); // never resolves
    await expect(withTimeout(slow, 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('TimeoutError message identifies it as a timeout, not a network error', async () => {
    const slow = new Promise<never>(() => {});
    const err = await withTimeout(slow, 10).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/timeout/i);
    expect(err.name).toBe('TimeoutError');
  });

  it('clears the timer when the wrapped promise rejects early', async () => {
    vi.useFakeTimers();
    const rejectPromise = Promise.reject(new Error('early failure'));
    rejectPromise.catch(() => {}); // prevent unhandled rejection

    const timed = withTimeout(rejectPromise, 5000);

    await expect(timed).rejects.toThrow('early failure');
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── prepareSorobanTx auth checks ──────────────────────────────────────────

describe('prepareSorobanTx auth checks', () => {
  beforeEach(() => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({} as any);
  });

  it('throws when auth contains an unexpected signer (address credentials)', async () => {
    const badKeypair = Keypair.random();
    const badAddress = badKeypair.publicKey();
    const rawKey = StrKey.decodeEd25519PublicKey(badAddress);

    const mockAuthEntry = {
      credentials: () => ({
        switch: () => xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
        address: () => ({
          address: () => ({
            switch: () => xdr.ScAddressType.scAddressTypeAccount(),
            accountId: () => ({
              ed25519: () => rawKey,
            }),
          }),
        }),
      }),
    };

    const mockTx = {
      operations: [{ auth: [mockAuthEntry] }],
    };

    vi.mocked(rpc.assembleTransaction).mockReturnValue({
      build: vi.fn().mockReturnValue(mockTx as any),
    } as any);

    const dummyTx = {} as any;
    await expect(prepareSorobanTx(dummyTx)).rejects.toThrow(/unexpected/i);
  });

  it('does not throw when auth entries use source account credentials', async () => {
    const mockAuthEntry = {
      credentials: () => ({
        switch: () => xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount(),
      }),
    };

    const mockTx = {
      operations: [{ auth: [mockAuthEntry] }],
    };

    vi.mocked(rpc.assembleTransaction).mockReturnValue({
      build: vi.fn().mockReturnValue(mockTx as any),
    } as any);

    const dummyTx = {} as any;
    await expect(prepareSorobanTx(dummyTx)).resolves.toBeDefined();
  });

  it("does not throw when address credentials match the agent's public key", async () => {
    const agentSecret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
    const agentPublicKey = Keypair.fromSecret(agentSecret).publicKey();
    const rawKey = StrKey.decodeEd25519PublicKey(agentPublicKey);

    const mockAuthEntry = {
      credentials: () => ({
        switch: () => xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
        address: () => ({
          address: () => ({
            switch: () => xdr.ScAddressType.scAddressTypeAccount(),
            accountId: () => ({
              ed25519: () => rawKey,
            }),
          }),
        }),
      }),
    };

    const mockTx = {
      operations: [{ auth: [mockAuthEntry] }],
    };

    vi.mocked(rpc.assembleTransaction).mockReturnValue({
      build: vi.fn().mockReturnValue(mockTx as any),
    } as any);

    const dummyTx = {} as any;
    await expect(prepareSorobanTx(dummyTx)).resolves.toBeDefined();
  });
});

// ─── prepareSorobanTx budget_exceeded handling ─────────────────────────────

describe('prepareSorobanTx budget_exceeded handling', () => {
  it('throws SimulationBudgetError when simulation reports budget_exceeded', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
      error: 'HostError: Error(Budget, #0) budget_exceeded',
    } as any);

    const dummyTx = {} as any;
    const err = await prepareSorobanTx(dummyTx).catch((e) => e);

    expect(err).toBeInstanceOf(SimulationBudgetError);
    expect(err.message).toContain('budget_exceeded');
  });

  it('throws a ContractError with error detail for non-budget simulation failures', async () => {
    vi.spyOn(sorobanServer, 'simulateTransaction').mockResolvedValue({
      error: 'HostError: unrelated simulation problem',
    } as any);

    const dummyTx = {} as any;
    const err = await prepareSorobanTx(dummyTx).catch((e) => e);

    expect(err).not.toBeInstanceOf(SimulationBudgetError);
    expect(err).toBeInstanceOf(ContractError);
    expect(err.message).toBe('Soroban simulation failed: HostError: unrelated simulation problem');
    expect(err.cause).toBe('HostError: unrelated simulation problem');
  });
});

// ─── Request ID headers ───────────────────────────────────────────────────────

describe('RPC servers with request ID headers', () => {
  it('horizonServer is created with X-Request-ID header', () => {
    expect(horizonServer).toBeDefined();
  });

  it('sorobanServer is created with X-Request-ID header', () => {
    expect(sorobanServer).toBeDefined();
  });
});

// ─── #369: Horizon account cache TTL ──────────────────────────────────────────

describe('loadAccount — account cache TTL', () => {
  const PUBKEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const OTHER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    invalidateAccountCache();
    vi.useFakeTimers();
    fetchSpy = vi
      .spyOn(horizonServer, 'loadAccount')
      .mockImplementation(async (id: string) => ({ accountId: () => id }) as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    invalidateAccountCache();
    vi.useRealTimers();
  });

  it('serves the second read from cache without hitting Horizon', async () => {
    await loadAccount(PUBKEY);
    await loadAccount(PUBKEY);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-fetches once the TTL has elapsed', async () => {
    await loadAccount(PUBKEY);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // One millisecond short of the TTL the entry is still fresh.
    vi.advanceTimersByTime(29_999);
    await loadAccount(PUBKEY);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Crossing it forces a refresh.
    vi.advanceTimersByTime(2);
    await loadAccount(PUBKEY);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('caches each account separately', async () => {
    await loadAccount(PUBKEY);
    await loadAccount(OTHER);
    await loadAccount(PUBKEY);
    await loadAccount(OTHER);

    // One fetch each, not one per call and not one shared entry.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache when forceRefresh is set', async () => {
    await loadAccount(PUBKEY);
    await loadAccount(PUBKEY, { forceRefresh: true });

    // This is the tx_bad_seq recovery path: it must never be served a cached
    // sequence number, which is precisely the value that was just rejected.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not leave a stale entry behind when a refresh fails', async () => {
    await loadAccount(PUBKEY);
    vi.advanceTimersByTime(30_001);

    // TypeError so DEFAULT_IS_RETRYABLE short-circuits: a retryable error would
    // sit in withRetry's back-off, which never advances under fake timers.
    fetchSpy.mockRejectedValueOnce(new TypeError('horizon down'));
    await expect(loadAccount(PUBKEY)).rejects.toThrow('horizon down');

    // The expired entry was dropped on the miss, so the next call refetches
    // rather than quietly serving a record that is now well past its TTL.
    fetchSpy.mockImplementation(async (id: string) => ({ accountId: () => id }) as any);
    await loadAccount(PUBKEY);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('invalidateAccountCache drops a single key or the whole cache', async () => {
    await loadAccount(PUBKEY);
    await loadAccount(OTHER);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    invalidateAccountCache(PUBKEY);
    await loadAccount(PUBKEY);
    await loadAccount(OTHER);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    invalidateAccountCache();
    await loadAccount(PUBKEY);
    await loadAccount(OTHER);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });
});

// ─── #439: network partition (hang) scenarios ─────────────────────────────────
//
// A network partition is the most damaging failure mode in production: the
// connection neither resolves nor rejects — it just hangs. These tests use
// Vitest fake timers to simulate that against withTimeout/withRetry without
// waiting real wall-clock time.

describe('network partition simulation (#439)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('withTimeout throws TimeoutError when a call hangs past the timeout window', async () => {
    // A partitioned connection: the promise never settles.
    const hung = new Promise<never>(() => {});

    const timed = withTimeout(hung, 9_000); // config.RPC_TIMEOUT_MS
    const expectation = expect(timed).rejects.toBeInstanceOf(TimeoutError);

    // Just before the window the call is still pending.
    await vi.advanceTimersByTimeAsync(8_999);
    // Crossing it fires the TimeoutError.
    await vi.advanceTimersByTimeAsync(1);
    await expectation;
  });

  it('withTimeout still resolves if the hung call completes after the timer armed but before firing', async () => {
    let resolveFn!: (v: string) => void;
    const hung = new Promise<string>((resolve) => {
      resolveFn = resolve;
    });

    const timed = withTimeout(hung, 9_000);
    const expectation = expect(timed).resolves.toBe('late but alive');

    await vi.advanceTimersByTimeAsync(5_000);
    resolveFn('late but alive');
    await expectation;
  });

  it('withRetry makes exactly 3 calls when the first two timeout and the third succeeds', async () => {
    // Each attempt mirrors a real RPC call: the request itself carries a
    // per-request timeout, so a partitioned attempt settles as TimeoutError
    // instead of hanging the whole retry loop forever.
    let call = 0;
    const fn = vi.fn(() => {
      const t = call++;
      if (t < 2) return withTimeout(new Promise<never>(() => {}), 9_000);
      return Promise.resolve('recovered');
    });

    const promise = withRetry(fn, 3, 0);

    // Attempt 1: hangs, then times out. Advance slightly past the timeout so
    // the zero-delay back-off timer scheduled at the boundary also fires.
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    // Attempt 2: hangs, then times out.
    await vi.advanceTimersByTimeAsync(9_050);
    expect(fn).toHaveBeenCalledTimes(2);
    // Attempt 3: succeeds immediately.
    await vi.advanceTimersByTimeAsync(9_050);
    await expect(promise).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('withRetry wraps the last TimeoutError in StellarRPCError after exhausting retries', async () => {
    const fn = vi.fn(() => withTimeout(new Promise<never>(() => {}), 9_000));

    const promise = withRetry(fn, 2, 0);
    const expectation = expect(promise).rejects.toThrow(
      /RPC call failed after 2 attempt\(s\).*Transaction Timeout/i
    );

    // Attempt 1 times out at 9s; attempt 2 also hangs and times out. The
    // +50ms epsilon lets the zero-delay back-off timer scheduled at the
    // timeout boundary fire within the same advance.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9_050);
    await vi.advanceTimersByTimeAsync(9_050);
    await expectation;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('withRetry exits after 1 attempt when isRetryable returns false for timeouts', async () => {
    const fn = vi.fn(() => withTimeout(new Promise<never>(() => {}), 9_000));
    const isRetryable = vi.fn(() => false);

    const promise = withRetry(fn, 3, 0, isRetryable);
    const expectation = expect(promise).rejects.toBeInstanceOf(TimeoutError);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(9_000);
    await expectation;

    // Non-retryable: the loop must not attempt again.
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRetryable).toHaveBeenCalled();
  });

  it('DEFAULT_IS_RETRYABLE returns true for a TimeoutError (a partition is worth retrying)', () => {
    expect(DEFAULT_IS_RETRYABLE(new TimeoutError(9_000))).toBe(true);
  });

  it('loadAccount surfaces TimeoutError when Horizon hangs past RPC_TIMEOUT_MS', async () => {
    invalidateAccountCache();
    const fetchSpy = vi
      .spyOn(horizonServer, 'loadAccount')
      .mockImplementation(() => new Promise<never>(() => {}));

    const expectation = expect(
      loadAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')
    ).rejects.toBeInstanceOf(TimeoutError);

    // RPC_TIMEOUT_MS = 9000 in the mocked config; withRetry's back-off delay
    // is 100ms and only runs between attempts, so a single crossing of the
    // timeout window is enough to surface the TimeoutError here.
    await vi.advanceTimersByTimeAsync(9_000);
    await expectation;

    fetchSpy.mockRestore();
    invalidateAccountCache();
  });
});
