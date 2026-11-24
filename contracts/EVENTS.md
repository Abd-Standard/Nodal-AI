# Contract Event Schemas

This document defines every event emitted by Nodal-AI's Soroban contracts.
The backend decoder at `backend/contracts/escrow/index.ts` uses these schemas to
produce typed `EscrowEvent` objects from raw `rpc.Api.EventResponse` values.

---

## Escrow Contract (`contracts/escrow`)

All escrow events are emitted as `contract` events via `env.events().publish(...)`.
Each row below documents:

| Field | Description |
|-------|-------------|
| **topic[0]** | The event discriminator Symbol (matches the `eventTypes` filter). |
| **data** | The XDR value encoded in the event's `value` field. |

---

### `initialized`

Emitted by `EscrowContract::initialize` when the escrow is successfully set up
and funds have been transferred from the depositor to the contract.

| Field       | XDR Type    | Rust type  | Description                             |
|-------------|-------------|------------|-----------------------------------------|
| `topic[0]`  | `Symbol`    | `String`   | `"initialized"`                         |
| `data[0]`   | `Address`   | `Address`  | Depositor address                       |
| `data[1]`   | `Address`   | `Address`  | Recipient address                       |
| `data[2]`   | `Int128`    | `i128`     | Locked amount (stroop-equivalent units) |

```rust
env.events().publish(
    (Symbol::new(&env, "initialized"),),
    (depositor, recipient, amount),
);
```

---

### `released`

Emitted by `EscrowContract::release` when the arbiter releases the full balance
to the recipient, and also by `EscrowContract::release_partial` when a partial
release drains the remaining balance to zero.

| Field       | XDR Type    | Rust type  | Description                             |
|-------------|-------------|------------|-----------------------------------------|
| `topic[0]`  | `Symbol`    | `String`   | `"released"`                            |
| `data[0]`   | `Address`   | `Address`  | Recipient address                       |
| `data[1]`   | `Int128`    | `i128`     | Released amount                         |

```rust
env.events().publish(
    (Symbol::new(&env, "released"),),
    (recipient, amount),
);
```

---

### `refunded`

Emitted by `EscrowContract::refund` when the depositor reclaims funds after
the escrow has expired.

| Field       | XDR Type    | Rust type  | Description                             |
|-------------|-------------|------------|-----------------------------------------|
| `topic[0]`  | `Symbol`    | `String`   | `"refunded"`                            |
| `data[0]`   | `Address`   | `Address`  | Depositor address (recipient of refund) |
| `data[1]`   | `Int128`    | `i128`     | Refunded amount                         |

```rust
env.events().publish(
    (Symbol::new(&env, "refunded"),),
    (stored_depositor, amount),
);
```

---

### `partial_released`

Emitted by `EscrowContract::release_partial` when a partial amount is transferred
to the recipient and the escrow still has a non-zero remaining balance.

| Field       | XDR Type    | Rust type  | Description                             |
|-------------|-------------|------------|-----------------------------------------|
| `topic[0]`  | `Symbol`    | `String`   | `"partial_released"`                    |
| `data[0]`   | `Address`   | `Address`  | Recipient address                       |
| `data[1]`   | `Int128`    | `i128`     | Amount released in this call            |
| `data[2]`   | `Int128`    | `i128`     | Remaining balance after this release    |

```rust
env.events().publish(
    (Symbol::new(&env, "partial_released"),),
    (recipient, release_amount, remaining),
);
```

---

### `cancelled`

Emitted by `EscrowContract::cancel` when both the depositor and arbiter
cooperatively cancel the escrow and the depositor's funds are returned.

| Field       | XDR Type    | Rust type  | Description                             |
|-------------|-------------|------------|-----------------------------------------|
| `topic[0]`  | `Symbol`    | `String`   | `"cancelled"`                           |
| `data[0]`   | `Address`   | `Address`  | Depositor address (recipient of return) |
| `data[1]`   | `Int128`    | `i128`     | Cancelled (returned) amount             |

```rust
env.events().publish(
    (Symbol::new(&env, "cancelled"),),
    (stored_depositor, amount),
);
```

---

## Decoder

The TypeScript decoder lives at `backend/contracts/escrow/index.ts` and exports:

```typescript
import { decodeEscrowEvent, EscrowEvent } from "./backend/contracts/escrow";

const event: EscrowEvent | null = decodeEscrowEvent(rawRpcEvent);
if (event) {
  switch (event.type) {
    case "initialized": /* event.depositor, event.recipient, event.amount */ break;
    case "released":    /* event.recipient, event.amount               */ break;
    case "refunded":    /* event.depositor, event.amount               */ break;
    case "partial_released": /* event.recipient, event.released, event.remaining */ break;
    case "cancelled":   /* event.depositor, event.amount               */ break;
  }
}
```

Returns `null` for any event whose topic does not match a known discriminator,
so callers can safely ignore unrecognised events without throwing.
