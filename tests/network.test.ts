import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the network module directly
import { isThrottled, handleRateLimitResponse, getBackoffStatus } from "../backend/network";

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
