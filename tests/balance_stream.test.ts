/**
 * tests/balance_stream.test.ts
 * Unit tests for BalanceStreamTool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BalanceStreamTool, BalanceEvent } from "../backend/tools/BalanceStreamTool";
import { horizonServer } from "../backend/rpc_client";

vi.mock("../backend/rpc_client", () => {
  return {
    horizonServer: {
      effects: vi.fn(),
    },
  };
});

describe("BalanceStreamTool", () => {
  let streamTool: BalanceStreamTool;
  let mockCloseStream: ReturnType<typeof vi.fn>;
  let streamCallbacks: { onmessage?: (effect: any) => void; onerror?: (err: any) => void };

  const samplePublicKey = "GA5W2X5GD25DPGFCC5GVGI6WGD25DPGFCC5GVGI6WGD25DPGFCC5GVGI6";

  beforeEach(() => {
    vi.clearAllMocks();
    streamTool = new BalanceStreamTool();
    mockCloseStream = vi.fn();
    streamCallbacks = {};

    (horizonServer.effects as any).mockReturnValue({
      forAccount: vi.fn().mockReturnValue({
        stream: vi.fn().mockImplementation((callbacks: any) => {
          streamCallbacks = callbacks;
          return mockCloseStream;
        }),
      }),
    });
  });

  it("subscribes to horizon.effects().forAccount(pk).stream()", () => {
    const emitter = streamTool.subscribe(samplePublicKey);
    expect(horizonServer.effects).toHaveBeenCalled();
    expect(emitter).toBeDefined();
  });

  it("emits typed balance event on account_credited (native XLM)", () => {
    const emitter = streamTool.subscribe(samplePublicKey);
    const events: BalanceEvent[] = [];
    emitter.on("balance", (e: BalanceEvent) => events.push(e));

    streamCallbacks.onmessage?.({
      type: "account_credited",
      asset_type: "native",
      amount: "100.0000000",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      assetCode: "XLM",
      amount: "100.0000000",
      direction: "credit",
    });
  });

  it("emits typed balance event on account_credited (custom asset)", () => {
    const emitter = streamTool.subscribe(samplePublicKey);
    const events: BalanceEvent[] = [];
    emitter.on("balance", (e: BalanceEvent) => events.push(e));

    streamCallbacks.onmessage?.({
      type: "account_credited",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      amount: "50.50",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      assetCode: "USDC",
      amount: "50.50",
      direction: "credit",
    });
  });

  it("emits typed balance event on account_debited", () => {
    const emitter = streamTool.subscribe(samplePublicKey);
    const events: BalanceEvent[] = [];
    emitter.on("balance", (e: BalanceEvent) => events.push(e));

    streamCallbacks.onmessage?.({
      type: "account_debited",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      amount: "25.00",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      assetCode: "USDC",
      amount: "25.00",
      direction: "debit",
    });
  });

  it("ignores non-payment effect types", () => {
    const emitter = streamTool.subscribe(samplePublicKey);
    const events: BalanceEvent[] = [];
    emitter.on("balance", (e: BalanceEvent) => events.push(e));

    streamCallbacks.onmessage?.({
      type: "signer_created",
      weight: 1,
    });

    expect(events).toHaveLength(0);
  });

  it("cleanly closes SSE stream when stop() is called", () => {
    streamTool.subscribe(samplePublicKey);
    streamTool.stop();
    expect(mockCloseStream).toHaveBeenCalledTimes(1);
  });

  it("handles stop() when no stream is active", () => {
    expect(() => streamTool.stop()).not.toThrow();
  });
});
