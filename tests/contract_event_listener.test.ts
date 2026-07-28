import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { listen } from "../backend/tools/ContractEventListener";
import * as rpcClient from "../backend/rpc_client";

vi.mock("../backend/rpc_client", () => ({
  sorobanServer: {
    getEvents: vi.fn(),
    getLatestLedger: vi.fn(),
  },
}));

vi.mock("../backend/config", () => ({
  config: {
    RETRY_DELAY_MS: 100,
  },
}));

vi.mock("../backend/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const VALID_CONTRACT = "CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH";

function makeEvent(topicStr: string, pagingToken: string) {
  return {
    topic: [{ toString: () => topicStr }],
    pagingToken,
  } as any;
}

describe("ContractEventListener", () => {
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

  it("invokes onEvent for matching events on poll", async () => {
    const event = makeEvent("released", "tok-1");
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [event],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, ["released"], onEvent);

    await vi.advanceTimersByTimeAsync(200);

    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it("does not invoke onEvent when topic does not match eventTypes", async () => {
    const event = makeEvent("cancelled", "tok-1");
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [event],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, ["released"], onEvent);

    await vi.advanceTimersByTimeAsync(200);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("stops polling after stopListening is called", async () => {
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

  it("logs an error and keeps polling when getEvents rejects", async () => {
    const { logger } = await import("../backend/logger");
    vi.mocked(rpcClient.sorobanServer.getEvents).mockRejectedValueOnce(
      new Error("RPC unavailable"),
    );

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    await vi.advanceTimersByTimeAsync(200);

    expect(logger.error).toHaveBeenCalled();
  });

  it("polls sorobanServer.getEvents() at the configured interval", async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [],
    } as any);

    const onEvent = vi.fn();
    // pollIntervalMs = RETRY_DELAY_MS * 2 = 200ms (mocked config)
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    await vi.advanceTimersByTimeAsync(600);

    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(3);
  });

  it("emits parsed events to registered callback", async () => {
    const event = makeEvent("released", "tok-1");
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [event],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, ["released"], onEvent);

    await vi.advanceTimersByTimeAsync(200);

    expect(onEvent).toHaveBeenCalledWith(event);
  });

  it("handles sorobanServer.getEvents() rejection without crashing", async () => {
    vi.mocked(rpcClient.sorobanServer.getEvents)
      .mockRejectedValueOnce(new Error("RPC unavailable"))
      .mockResolvedValue({ events: [] } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, [], onEvent);

    // The listener should keep polling on subsequent ticks rather than dying.
    await vi.advanceTimersByTimeAsync(600);

    expect(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(3);
  });

  it("stops polling when stop() is called", async () => {
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

  it("does not emit events after stop() is called", async () => {
    const event = makeEvent("released", "tok-1");
    vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
      events: [event],
    } as any);

    const onEvent = vi.fn();
    stopListening = listen(VALID_CONTRACT, ["released"], onEvent);

    await vi.advanceTimersByTimeAsync(200);
    expect(onEvent).toHaveBeenCalledTimes(1);

    stopListening();
    await vi.advanceTimersByTimeAsync(1000);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
