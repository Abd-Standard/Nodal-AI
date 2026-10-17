import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { listen } from '../backend/tools/ContractEventListener';
import * as rpcClient from '../backend/rpc_client';

vi.mock('../backend/rpc_client', () => ({
  sorobanServer: {
    getEvents: vi.fn(),
    getLatestLedger: vi.fn(),
  },
}));

vi.mock('../backend/config', () => ({
  config: {
    RETRY_DELAY_MS: 100,
    CONTRACT_EVENT_POLL_MS: 300,
  },
}));

vi.mock('../backend/logger', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const VALID_CONTRACT = 'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH';

function makeEvent(topicStr: string, pagingToken: string) {
  return {
    topic: [{ toString: () => topicStr }],
    pagingToken,
  } as any;
}

describe('ContractEventListener', () => {
  let stopListening: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(rpcClient.sorobanServer.getLatestLedger).mockResolvedValue({
      sequence: 1000,
    } as any);
  });

  afterEach(() => {
    stopListening?.();
    vi.useRealTimers();
  });

  it('invokes onEvent for matching events on poll', async () => {
    const event = makeEvent('released', 'tok-1');
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [event],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, ['released'], onEvent);

    await vi.advanceTimersByTimeAsync(200);

    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('does not invoke onEvent when topic does not match eventTypes', async () => {
    const event = makeEvent('cancelled', 'tok-1');
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [event],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, ['released'], onEvent);

    await vi.advanceTimersByTimeAsync(200);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('stops polling after stopListening is called', async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    await vi.advanceTimersByTimeAsync(200);
    const callsBeforeStop = vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length;

    stopListening();
    await vi.advanceTimersByTimeAsync(500);

    expect(vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length).toBe(callsBeforeStop);
  });

  it('logs an error and keeps polling when getEvents rejects', async () => {
    const { logger } = await import('../backend/logger');
    vi.mocked(rpcClient.sorobanServer.getEvents).mockRejectedValueOnce(
      new Error('RPC unavailable')
    );

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    await vi.advanceTimersByTimeAsync(200);

    expect(logger.error).toHaveBeenCalled();
  });

  it('polls sorobanServer.getEvents() at the configured interval', async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    await vi.advanceTimersByTimeAsync(600);

    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(3);
  });

  it('emits parsed events to registered callback', async () => {
    const event = makeEvent('released', 'tok-1');
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [event],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, ['released'], onEvent);

    await vi.advanceTimersByTimeAsync(200);

    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it('handles sorobanServer.getEvents() rejection without crashing', async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents)
      .mockRejectedValueOnce(new Error('RPC unavailable'))
      .mockResolvedValue({ events: [] } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    // The listener should keep polling on subsequent ticks rather than dying.
    await vi.advanceTimersByTimeAsync(600);

    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(3);
  });

  it('stops polling when stop() is called', async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    await vi.advanceTimersByTimeAsync(200);
    const callsBeforeStop = vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length;

    stopListening();
    await vi.advanceTimersByTimeAsync(600);

    expect(vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length).toBe(callsBeforeStop);
  });

  it('does not emit events after stop() is called', async () => {
    const event = makeEvent('released', 'tok-1');
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [event],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, ['released'], onEvent);

    await vi.advanceTimersByTimeAsync(200);
    expect(onEvent).toHaveBeenCalledTimes(1);

    stopListening();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  // ── Reconnect & Exhaustion ──────────────────────────────────────────────────

  it('reconnects with exponential backoff when stream drops and resumes emitting events', async () => {
    const event = makeEvent('released', 'tok-2');
    vi.mocked(rpcClient.sorobanServer.getEvents)
      .mockRejectedValueOnce(new Error('Connection reset 1'))
      .mockRejectedValueOnce(new Error('Connection reset 2'))
      .mockResolvedValueOnce({ events: [event] } as any)
      .mockResolvedValue({ events: [] } as any);

    const onEvent = vi.fn();
    const onError = vi.fn();
    const handle = listen(VALID_CONTRACT, ['released'], onEvent);
    handle.on('error', onError);
    stopListening = handle;

    // t=0: call 1 fails (attempt 1 -> wait 300ms)
    await vi.advanceTimersByTimeAsync(300);
    // t=300: call 2 fails (attempt 2 -> wait 600ms)
    await vi.advanceTimersByTimeAsync(600);
    // t=900: call 3 succeeds, receives event!
    await vi.advanceTimersByTimeAsync(100);

    expect(onEvent).toHaveBeenCalledWith(event);
    expect(onError).not.toHaveBeenCalled();

    // Now advance another 300ms: pollIntervalMs has reset back to normal interval
    await vi.advanceTimersByTimeAsync(300);
    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(4);
  });

  it('emits error event on returned EventEmitter when reconnect retries are exhausted (default 5)', async () => {
    const rpcError = new Error('RPC permanent drop');
    vi.mocked(rpcClient.sorobanServer.getEvents).mockRejectedValue(rpcError);

    const onEvent = vi.fn();
    const onError = vi.fn();
    const handle = listen(VALID_CONTRACT, [], onEvent);
    handle.on('error', onError);
    stopListening = handle;

    // Attempt 1: t=0, fails. Wait 300ms.
    await vi.advanceTimersByTimeAsync(300);
    // Attempt 2: t=300, fails. Wait 600ms.
    await vi.advanceTimersByTimeAsync(600);
    // Attempt 3: t=900, fails. Wait 1200ms.
    await vi.advanceTimersByTimeAsync(1200);
    // Attempt 4: t=2100, fails. Wait 2400ms.
    await vi.advanceTimersByTimeAsync(2400);
    // Attempt 5: t=4500, fails -> exhaustion!
    await vi.advanceTimersByTimeAsync(100);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(rpcError);
    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(5);

    // Verify polling has stopped completely
    await vi.advanceTimersByTimeAsync(10000);
    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(5);
  });

  it('respects maxReconnectAttempts configurable at call time', async () => {
    const rpcError = new Error('Stream dropped');
    vi.mocked(rpcClient.sorobanServer.getEvents).mockRejectedValue(rpcError);

    const onEvent = vi.fn();
    const onError = vi.fn();
    const handle = listen(VALID_CONTRACT, [], onEvent, { maxReconnectAttempts: 2 });
    handle.on('error', onError);
    stopListening = handle;

    // Attempt 1: t=0, fails. Wait 300ms.
    await vi.advanceTimersByTimeAsync(300);
    // Attempt 2: t=300, fails -> exhaustion at 2!
    await vi.advanceTimersByTimeAsync(100);

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(rpcError);
    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(2);
  });

  // ── Start / Stop lifecycle (#457) ──────────────────────────────────────────

  it('start → emit 2 events → stop → no further events arrive', async () => {
    const event1 = makeEvent('released', 'tok-10');
    const event2 = makeEvent('released', 'tok-11');

    // First two polls return events; subsequent polls return empty
    vi.mocked(rpcClient.sorobanServer.getEvents)
      .mockResolvedValueOnce({ events: [event1] } as any)
      .mockResolvedValueOnce({ events: [event2] } as any)
      .mockResolvedValue({ events: [] } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, ['released'], onEvent);

    // Advance through two poll cycles (each 300ms)
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(300);

    expect(onEvent).toHaveBeenCalledTimes(2);

    const callsAtStop = vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length;
    stopListening();

    // Advance far past the poll interval — no further calls should occur
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length).toBe(callsAtStop);
    // onEvent was invoked exactly twice and nothing more
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('stop() before any events arrive — listener does not throw', async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [],
    } as any);

    const onEvent = vi.fn();

    // stop() immediately — the in-flight first poll may or may not have
    // fired, but nothing should throw
    expect(() => {
      stopListening = listen(VALID_CONTRACT, [], onEvent);
      stopListening();
    }).not.toThrow();

    // Confirm polling truly stops
    await vi.advanceTimersByTimeAsync(2000);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('stop() is idempotent — calling it twice does not throw', async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    await vi.advanceTimersByTimeAsync(300);

    expect(() => {
      stopListening();
      stopListening(); // second call should be a no-op
    }).not.toThrow();
  });

  it('no timer leak after stop() — clearTimeout called for the pending timer', async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [],
    } as any);

    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    // Let one poll cycle complete so a next-tick timer is scheduled
    await vi.advanceTimersByTimeAsync(300);

    stopListening();

    // clearTimeout must have been called to cancel the scheduled next poll
    expect(clearTimeoutSpy).toHaveBeenCalled();

    clearTimeoutSpy.mockRestore();
  });
});
