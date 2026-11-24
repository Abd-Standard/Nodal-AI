/**
 * tests/escrow_event_decoder.test.ts
 *
 * Tests for the typed escrow-event decoder at backend/contracts/escrow/index.ts.
 *
 * Every escrow event documented in contracts/EVENTS.md is covered here.
 * Fixtures are hand-constructed raw EventResponse objects whose `topic` and
 * `value` fields mirror what the Soroban test suite produces, so the same
 * fixtures serve as a cross-check that the documentation is accurate.
 *
 * Relies on `@stellar/stellar-sdk` being available (it is a production dep).
 */

import { describe, it, expect } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import {
  decodeEscrowEvent,
  ESCROW_EVENT_TYPES,
  type EscrowEvent,
} from "../backend/contracts/escrow";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEPOSITOR = "GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5";
const RECIPIENT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const AMOUNT = 500n;
const RELEASED_AMOUNT = 200n;
const REMAINING = 300n;

/**
 * Build a minimal `rpc.Api.EventResponse`-shaped object.
 * `scValToNative(topic0)` → discriminator string
 * `scValToNative(value)`  → native tuple for the data fields
 */
function makeRawEvent(discriminator: string, dataFields: unknown[]): any {
  return {
    topic: [nativeToScVal(discriminator, { type: "symbol" })],
    value: nativeToScVal(dataFields),
  };
}

// ─── Decoder coverage ────────────────────────────────────────────────────────

describe("decodeEscrowEvent", () => {
  describe("initialized event", () => {
    it("decodes all three fields correctly", () => {
      const raw = makeRawEvent("initialized", [DEPOSITOR, RECIPIENT, AMOUNT]);
      const event = decodeEscrowEvent(raw) as Extract<EscrowEvent, { type: "initialized" }>;

      expect(event).not.toBeNull();
      expect(event.type).toBe("initialized");
      expect(event.depositor).toBe(DEPOSITOR);
      expect(event.recipient).toBe(RECIPIENT);
      expect(event.amount).toBe(AMOUNT);
    });

    it("throws when data arity is wrong (2 fields instead of 3)", () => {
      const raw = makeRawEvent("initialized", [DEPOSITOR, RECIPIENT]);
      expect(() => decodeEscrowEvent(raw)).toThrow(/expected 3 data fields/);
    });
  });

  describe("released event", () => {
    it("decodes recipient and amount", () => {
      const raw = makeRawEvent("released", [RECIPIENT, AMOUNT]);
      const event = decodeEscrowEvent(raw) as Extract<EscrowEvent, { type: "released" }>;

      expect(event.type).toBe("released");
      expect(event.recipient).toBe(RECIPIENT);
      expect(event.amount).toBe(AMOUNT);
    });

    it("throws when data arity is wrong (1 field instead of 2)", () => {
      const raw = makeRawEvent("released", [RECIPIENT]);
      expect(() => decodeEscrowEvent(raw)).toThrow(/expected 2 data fields/);
    });
  });

  describe("refunded event", () => {
    it("decodes depositor and amount", () => {
      const raw = makeRawEvent("refunded", [DEPOSITOR, AMOUNT]);
      const event = decodeEscrowEvent(raw) as Extract<EscrowEvent, { type: "refunded" }>;

      expect(event.type).toBe("refunded");
      expect(event.depositor).toBe(DEPOSITOR);
      expect(event.amount).toBe(AMOUNT);
    });

    it("throws when data arity is wrong", () => {
      const raw = makeRawEvent("refunded", []);
      expect(() => decodeEscrowEvent(raw)).toThrow(/expected 2 data fields/);
    });
  });

  describe("partial_released event", () => {
    it("decodes recipient, released, and remaining", () => {
      const raw = makeRawEvent("partial_released", [RECIPIENT, RELEASED_AMOUNT, REMAINING]);
      const event = decodeEscrowEvent(raw) as Extract<EscrowEvent, { type: "partial_released" }>;

      expect(event.type).toBe("partial_released");
      expect(event.recipient).toBe(RECIPIENT);
      expect(event.released).toBe(RELEASED_AMOUNT);
      expect(event.remaining).toBe(REMAINING);
    });

    it("throws when data arity is wrong (2 fields instead of 3)", () => {
      const raw = makeRawEvent("partial_released", [RECIPIENT, RELEASED_AMOUNT]);
      expect(() => decodeEscrowEvent(raw)).toThrow(/expected 3 data fields/);
    });
  });

  describe("cancelled event", () => {
    it("decodes depositor and amount", () => {
      const raw = makeRawEvent("cancelled", [DEPOSITOR, AMOUNT]);
      const event = decodeEscrowEvent(raw) as Extract<EscrowEvent, { type: "cancelled" }>;

      expect(event.type).toBe("cancelled");
      expect(event.depositor).toBe(DEPOSITOR);
      expect(event.amount).toBe(AMOUNT);
    });

    it("throws when data arity is wrong", () => {
      const raw = makeRawEvent("cancelled", [DEPOSITOR]);
      expect(() => decodeEscrowEvent(raw)).toThrow(/expected 2 data fields/);
    });
  });

  describe("unknown / unrecognised events", () => {
    it("returns null for an unknown discriminator", () => {
      const raw = makeRawEvent("fee_paid", [DEPOSITOR, AMOUNT]);
      expect(decodeEscrowEvent(raw)).toBeNull();
    });

    it("returns null when topic array is empty", () => {
      const raw = { topic: [], value: nativeToScVal([]) };
      expect(decodeEscrowEvent(raw as any)).toBeNull();
    });
  });

  describe("ESCROW_EVENT_TYPES constant", () => {
    it("contains all five documented event types", () => {
      expect(ESCROW_EVENT_TYPES).toContain("initialized");
      expect(ESCROW_EVENT_TYPES).toContain("released");
      expect(ESCROW_EVENT_TYPES).toContain("refunded");
      expect(ESCROW_EVENT_TYPES).toContain("partial_released");
      expect(ESCROW_EVENT_TYPES).toContain("cancelled");
      expect(ESCROW_EVENT_TYPES).toHaveLength(5);
    });
  });
});
