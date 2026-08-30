import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the network module directly
import { isThrottled, handleRateLimitResponse, getBackoffStatus, withBackoffGuard } from "../backend/network";

describe("Network Rate Limiting", () => {
  beforeEach(() => {
    // Reset by calling handle with past timestamp to clear
    // We cant access internals, so test via public API
  });

  it("should not be throttled initially", () => {
    expect(isThrottled()).toBe(false);
    expect(getBackoffStatus().active).toBe(false);
  });

  it("should activate backoff on 429 with Retry-After", () => {
    handleRateLimitResponse("60");
    expect(isThrottled()).toBe(true);
    expect(getBackoffStatus().active).toBe(true);
    expect(getBackoffStatus().retryAfterSeconds).toBe(60);
  });

  it("should use default 30s when no Retry-After header", () => {
    handleRateLimitResponse(null);
    expect(isThrottled()).toBe(true);
    expect(getBackoffStatus().retryAfterSeconds).toBe(30);
  });

  it("should not be throttled after backoff expires", async () => {
    handleRateLimitResponse("1");
    expect(isThrottled()).toBe(true);
    await new Promise((r) => setTimeout(r, 1100));
    expect(isThrottled()).toBe(false);
  });
});

describe("withBackoffGuard queuing behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues a call when throttled and executes it after backoff clears", async () => {
    handleRateLimitResponse("5");
    expect(isThrottled()).toBe(true);

    const fn = vi.fn().mockResolvedValue("done");
    const resultPromise = withBackoffGuard(fn);

    // Still throttled — the callback must not run yet.
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("drains all queued callbacks in order when lock clears", async () => {
    handleRateLimitResponse("5");

    const order: number[] = [];
    const makeFn = (n: number) =>
      vi.fn().mockImplementation(async () => {
        order.push(n);
        return n;
      });
    const fn1 = makeFn(1);
    const fn2 = makeFn(2);
    const fn3 = makeFn(3);

    const p1 = withBackoffGuard(fn1);
    const p2 = withBackoffGuard(fn2);
    const p3 = withBackoffGuard(fn3);

    expect(getBackoffStatus().queueSize).toBe(3);

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("a queued callback that rejects propagates the rejection to the caller", async () => {
    handleRateLimitResponse("5");

    const error = new Error("queued callback failed");
    const fn = vi.fn().mockRejectedValue(error);
    const resultPromise = withBackoffGuard(fn);

    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).rejects.toThrow("queued callback failed");
  });

  it("does not strand a queued callback when a stale auto-clear timer fires mid-enqueue (concurrent enqueue + expiry race)", async () => {
    handleRateLimitResponse("5"); // generation 1, auto-clear timer fires at +5000ms

    await vi.advanceTimersByTimeAsync(2000);

    // A fresh 429 arrives before the first backoff expired — this activates
    // generation 2 and reschedules the auto-clear, but the generation-1
    // timer from above is still pending and will fire at the 5000ms mark.
    handleRateLimitResponse("10"); // generation 2, auto-clear timer fires at +12000ms

    const fn = vi.fn().mockResolvedValue("done");
    const resultPromise = withBackoffGuard(fn);
    expect(getBackoffStatus().queueSize).toBe(1);

    // The stale generation-1 timer fires here. It must not clear the still
    // active generation-2 backoff or strand/drop the queued callback.
    await vi.advanceTimersByTimeAsync(3000); // total elapsed: 5000ms
    expect(isThrottled()).toBe(true);
    expect(getBackoffStatus().queueSize).toBe(1);
    expect(fn).not.toHaveBeenCalled();

    // The real generation-2 timer fires here and drains the queue.
    await vi.advanceTimersByTimeAsync(7000); // total elapsed: 12000ms
    await expect(resultPromise).resolves.toBe("done");
    expect(getBackoffStatus().queueSize).toBe(0);
    expect(isThrottled()).toBe(false);
  });

  it("rejects a callback enqueued in an earlier backoff generation once a later generation drains the queue", async () => {
    handleRateLimitResponse("5"); // generation 1

    const fn = vi.fn().mockResolvedValue("should not run");
    const resultPromise = withBackoffGuard(fn);
    resultPromise.catch(() => {});

    // Superseded before its own timer fires.
    handleRateLimitResponse("5"); // generation 2

    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).rejects.toThrow(/superseded/i);
    expect(fn).not.toHaveBeenCalled();
    expect(getBackoffStatus().queueSize).toBe(0);
  });
});
