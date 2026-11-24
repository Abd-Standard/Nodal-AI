/**
 * backend/contracts/escrow/index.ts
 *
 * Typed decoder for events emitted by the Nodal-AI PayFi Escrow contract.
 *
 * Every event shape is documented in `contracts/EVENTS.md`.
 * This module converts raw `rpc.Api.EventResponse` values (which carry XDR
 * ScVal topics and data) into plain TypeScript objects so the backend can
 * switch on `event.type` without ad-hoc string parsing.
 *
 * Usage:
 *   import { decodeEscrowEvent } from "./backend/contracts/escrow";
 *   const event = decodeEscrowEvent(rawEvent);
 *   if (event?.type === "released") { ... event.recipient, event.amount ... }
 */

import { rpc, scValToNative } from "@stellar/stellar-sdk";

// ─── Discriminated-union event types ─────────────────────────────────────────

/** Emitted by `initialize` — depositor locked funds. */
export interface InitializedEvent {
  readonly type: "initialized";
  /** G-address of the depositor. */
  readonly depositor: string;
  /** G-address of the recipient. */
  readonly recipient: string;
  /** Locked amount in stroop-equivalent units. */
  readonly amount: bigint;
}

/** Emitted by `release` (full) or `release_partial` (when remaining reaches 0). */
export interface ReleasedEvent {
  readonly type: "released";
  /** G-address of the recipient. */
  readonly recipient: string;
  /** Released amount in stroop-equivalent units. */
  readonly amount: bigint;
}

/** Emitted by `refund` after expiry. */
export interface RefundedEvent {
  readonly type: "refunded";
  /** G-address of the depositor (refund recipient). */
  readonly depositor: string;
  /** Refunded amount in stroop-equivalent units. */
  readonly amount: bigint;
}

/** Emitted by `release_partial` when funds remain after the release. */
export interface PartialReleasedEvent {
  readonly type: "partial_released";
  /** G-address of the recipient. */
  readonly recipient: string;
  /** Amount transferred in this call. */
  readonly released: bigint;
  /** Remaining balance still held by the contract. */
  readonly remaining: bigint;
}

/** Emitted by `cancel` — both depositor and arbiter cooperatively cancelled. */
export interface CancelledEvent {
  readonly type: "cancelled";
  /** G-address of the depositor (funds returned here). */
  readonly depositor: string;
  /** Returned amount in stroop-equivalent units. */
  readonly amount: bigint;
}

/** Union of all decoded escrow events. */
export type EscrowEvent =
  | InitializedEvent
  | ReleasedEvent
  | RefundedEvent
  | PartialReleasedEvent
  | CancelledEvent;

// ─── Known event discriminators ───────────────────────────────────────────────

export const ESCROW_EVENT_TYPES = [
  "initialized",
  "released",
  "refunded",
  "partial_released",
  "cancelled",
] as const;

export type EscrowEventType = (typeof ESCROW_EVENT_TYPES)[number];

// ─── Decoder ─────────────────────────────────────────────────────────────────

/**
 * Decode a raw Soroban `EventResponse` into a typed `EscrowEvent`.
 *
 * Returns `null` when the event's first topic does not match any known
 * escrow discriminator, so callers can safely ignore unrecognised events.
 *
 * Throws if the event matches a known discriminator but the data payload is
 * malformed (wrong arity or type), because that indicates a contract change
 * that the decoder has not been updated to handle.
 *
 * @param raw - A raw event from `sorobanServer.getEvents()`.
 * @returns Typed `EscrowEvent` or `null` for unrecognised events.
 */
export function decodeEscrowEvent(
  raw: rpc.Api.EventResponse
): EscrowEvent | null {
  // topic is an array of ScVal; the first element is the discriminator Symbol.
  const topic0 = raw.topic[0];
  if (!topic0) return null;

  const discriminator: string = scValToNative(topic0 as any);

  // The contract encodes event data as a tuple (Vec<ScVal>) published via
  // env.events().publish((topic,), (field1, field2, ...)). The SDK exposes
  // `raw.value` as a single ScVal that wraps the tuple.
  const rawData = (raw as any).value;
  // Decode to a native JS array; each element maps to a Rust tuple field.
  const data: unknown[] = rawData ? (scValToNative(rawData as any) as any[]) : [];

  switch (discriminator) {
    case "initialized": {
      assertArity("initialized", data, 3);
      return {
        type: "initialized",
        depositor: assertString(data[0], "initialized.depositor"),
        recipient: assertString(data[1], "initialized.recipient"),
        amount: assertBigInt(data[2], "initialized.amount"),
      };
    }

    case "released": {
      assertArity("released", data, 2);
      return {
        type: "released",
        recipient: assertString(data[0], "released.recipient"),
        amount: assertBigInt(data[1], "released.amount"),
      };
    }

    case "refunded": {
      assertArity("refunded", data, 2);
      return {
        type: "refunded",
        depositor: assertString(data[0], "refunded.depositor"),
        amount: assertBigInt(data[1], "refunded.amount"),
      };
    }

    case "partial_released": {
      assertArity("partial_released", data, 3);
      return {
        type: "partial_released",
        recipient: assertString(data[0], "partial_released.recipient"),
        released: assertBigInt(data[1], "partial_released.released"),
        remaining: assertBigInt(data[2], "partial_released.remaining"),
      };
    }

    case "cancelled": {
      assertArity("cancelled", data, 2);
      return {
        type: "cancelled",
        depositor: assertString(data[0], "cancelled.depositor"),
        amount: assertBigInt(data[1], "cancelled.amount"),
      };
    }

    default:
      // Unknown discriminator — not an escrow event we recognise.
      return null;
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function assertArity(
  eventType: string,
  data: unknown[],
  expected: number
): void {
  if (data.length !== expected) {
    throw new Error(
      `EscrowEvent decoder: "${eventType}" expected ${expected} data fields, ` +
        `got ${data.length}. Contract may have changed — update the decoder.`
    );
  }
}

function assertString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(
    `EscrowEvent decoder: field "${field}" expected string, got ${typeof value}`
  );
}

function assertBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  // scValToNative may return a number for small int128 values on some SDK builds
  if (typeof value === "number") return BigInt(value);
  throw new Error(
    `EscrowEvent decoder: field "${field}" expected bigint/number, got ${typeof value}`
  );
}
