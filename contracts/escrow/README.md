# Stellar PayFi Escrow Contract

A production-grade, secure, and gas-efficient Soroban (Stellar) escrow smart contract designed for PayFi operations. The contract enforces state transitions, multi-party authorization, and time-locked balances.

---

## Storage Layout

The contract stores its state in the persistent instance storage using the `DataKey` enum structure:

| Key (`DataKey`) | Value Type | Description |
| :--- | :--- | :--- |
| `Depositor` | `Address` | The account that funds the escrow and is eligible for refunds after expiration. |
| `Recipient` | `Address` | The destination account that receives the locked funds upon successful release. |
| `Arbiter` | `Address` | The trusted third-party key responsible for authorising the release of funds. |
| `Token` | `Address` | The contract address of the Stellar Asset Contract (SAC) token being held. |
| `Amount` | `i128` | The amount of token locked (in stroop-equivalent decimal units). |
| `Expiry` | `u64` | The Unix timestamp (seconds) after which a refund can be executed by the depositor. |
| `Released` | `bool` | A boolean flag indicating if the escrow has been settled (released or refunded). |
| `InitializedAt` | `u64` | The ledger timestamp (seconds) at which `initialize` ran; returned as `initialized_at` in `EscrowState`. |
| `PendingArbiter` | `Address` | The replacement arbiter proposed by the depositor via `propose_new_arbiter`. Present only while a rotation is pending; removed by `accept_arbiter_rotation`. |
| `PendingArbiterTime` | `u64` | The ledger timestamp (seconds) at which the pending rotation was proposed. `accept_arbiter_rotation` succeeds only once `MIN_ROTATION_DELAY` (24 hours) has elapsed since this time; removed together with `PendingArbiter`. |

---

## Lifecycle State Machine

The contract transitions through three lifecycle states:

```
    [ Uninitialized ]
           │
           │  initialize() (locks tokens)
           ▼
       [ Active ]
         ╱    ╲
        ╱      ╲  refund() (depositor, if current_time >= expiry)
       ╱        ╲
      ╱          ▼
     │       [ Settled ] (tokens returned to depositor)
     │
     │  release() (arbiter)
     ▼
 [ Settled ] (tokens sent to recipient)
```

1. **`Uninitialized`**: The contract has no active state. The `DataKey::Depositor` does not exist in instance storage.
2. **`Active`**: The contract has been initialized. Funds are held in the contract account. `DataKey::Released` is `false`.
3. **`Settled`**: The contract has been successfully resolved. Funds are transferred out, and `DataKey::Released` is updated to `true`.

---

## Public Functions & Authentication Requirements

All public entry points are defined on the `EscrowContract` struct:

### `initialize(env: Env, depositor: Address, recipient: Address, arbiter: Address, token: Address, amount: i128, expiry: u64)`
- **Purpose**: Initialises state, asserts constraints, and pulls tokens from the depositor to lock them in the contract.
- **Authorization**: Requires depositor signature (`depositor.require_auth()`).
- **Validation**:
  - `amount` must be greater than zero.
  - `expiry` timestamp must be strictly in the future.

### `release(env: Env, arbiter: Address)`
- **Purpose**: Settles the escrow by transferring locked funds to the recipient.
- **Authorization**: Requires arbiter signature (`arbiter.require_auth()`).
- **Validation**:
  - Only the registered arbiter can execute.
  - Escrow must be in the `Active` state (not yet released or refunded).

### `refund(env: Env, depositor: Address)`
- **Purpose**: Reclaims locked funds back to the depositor if the expiration time has elapsed.
- **Authorization**: Requires depositor signature (`depositor.require_auth()`).
- **Validation**:
  - Only the registered depositor can execute.
  - Escrow must be in the `Active` state.
  - Current ledger time must be greater than or equal to `expiry`.

### `get_state(env: Env) -> EscrowState`
- **Purpose**: Reads and returns the current lifecycle state of the escrow (`Uninitialized`, `Active`, or `Settled`).
- **Authorization**: None (Read-only query).

### `release_partial(env: Env, arbiter: Address, release_amount: i128)`
- **Purpose**: Releases a partial amount of the locked funds to the recipient, enabling milestone-based payouts. The escrow stays `Active` until the remaining stored amount reaches zero, at which point it is sealed (`Released = true`).
- **Authorization**: Requires stored arbiter signature (`stored_arbiter.require_auth()`); the `arbiter` argument must match the registered arbiter.
- **Validation**:
  - Only the registered arbiter can execute.
  - Escrow must be in the `Active` state (not yet released or refunded).
  - `release_amount` must be positive and must not exceed the stored locked amount.

### `cancel(env: Env, depositor: Address, arbiter: Address)`
- **Purpose**: Cooperatively cancels the escrow and returns the full locked amount to the depositor.
- **Authorization**: Requires both stored depositor and stored arbiter signatures (`stored_depositor.require_auth()` and `stored_arbiter.require_auth()`).
- **Validation**:
  - The `depositor` and `arbiter` arguments must match the registered depositor and arbiter respectively.
  - Escrow must be in the `Active` state.

### `propose_new_arbiter(env: Env, depositor: Address, new_arbiter: Address)`
- **Purpose**: Proposes a replacement arbiter, starting the time-locked rotation window enforced by `MIN_ROTATION_DELAY` (24 hours).
- **Authorization**: Requires stored depositor signature (`stored_depositor.require_auth()`); the `depositor` argument must match the registered depositor.
- **Validation**:
  - Only the registered depositor can execute.
  - Escrow must be initialized.

### `accept_arbiter_rotation(env: Env)`
- **Purpose**: Finalizes the pending arbiter rotation once the time-lock has expired, replacing the registered arbiter and clearing the pending rotation keys.
- **Authorization**: None (permissionless once the time-lock has expired — callable by anyone).
- **Validation**:
  - A rotation must have been proposed via `propose_new_arbiter` (otherwise `NoPendingRotation`).
  - At least `MIN_ROTATION_DELAY` (24 hours) must have elapsed since the proposal (otherwise `RotationLocked`).

---

## EscrowError Reference

If an execution condition is violated, the contract panics with one of the following custom `EscrowError` variants:

| Code | Variant | Description |
| :--- | :--- | :--- |
| `1` | `AlreadyInitialized` | The escrow contract is already initialised. |
| `2` | `AlreadyReleased` | The funds have already been released or refunded. |
| `3` | `NotExpired` | The escrow has not yet expired. |
| `4` | `NotArbiter` | The caller is not the authorized arbiter. |
| `5` | `NotDepositor` | The caller is not the authorized depositor. |
| `6` | `InvalidAmount` | The transfer amount must be positive. |
| `7` | `InvalidExpiry` | The expiry timestamp must be in the future. |
| `8` | `NotInitialized` | The escrow has not been initialized yet. |
| `9` | `InvalidParties` | Depositor, recipient, and arbiter must all be distinct addresses. |
| `10` | `RotationLocked` | The arbiter rotation time-lock has not yet expired. |
| `11` | `NoPendingRotation` | No pending arbiter rotation proposal. |

> **Keep this table in sync:** it is generated from the `EscrowError` enum in [`src/lib.rs`](src/lib.rs) (codes and doc comments). Whenever that enum changes, regenerate the table from it rather than editing rows by hand.

---

## Event Emissions & Confidentiality Audit

Soroban emits contract events as **public on-chain data**. Every event is readable by any observer via `getEvents`, and the *topics* are the indexed, independently-filterable portion of an event. Because of this, an event that places private information in its topics constitutes an information disclosure. The following is a targeted audit of every `env.events().publish` emission in `lib.rs` (as of this audit):

| Function | Topic(s) | Data payload | Private data in topics? |
| :--- | :--- | :--- | :--- |
| `initialize` | `escrow`, `initialized` | `depositor`, `recipient`, `amount` | No |
| `release` | `escrow`, `released` | `recipient`, `amount` | No |
| `refund` | `refunded` | `depositor`, `amount` | No |
| `release_partial` | `partial_released` / `released` | `recipient`, `release_amount`, `remaining` | No |
| `cancel` | `escrow`, `cancelled` | `depositor`, `amount` | No |
| `propose_new_arbiter` | `arbiter_rotation_proposed` | `depositor`, `new_arbiter`, `now` | No |
| `accept_arbiter_rotation` | `arbiter_rotation_accepted` | `new_arbiter`, `now` | No |

### Audit conclusion: **No information disclosure found**

1. **Topics carry only fixed event-name literals.** Every topic is a hardcoded `Symbol::new(&env, "...")` (e.g. `escrow`, `released`, `refunded`) used solely for event *type* classification. No caller-supplied or user-controlled value ever appears in a topic, and no private metadata (memos, off-chain references, PII) exists in contract storage to leak.
2. **All data-payload values are already public on-chain state.** The payloads contain only addresses (`depositor`, `recipient`, `arbiter`, `new_arbiter`) and amounts/timestamps, each already disclosed by the public `get_state()` read function and ledger timestamps. Emitting them in events therefore reveals nothing that any on-chain observer could not already read directly.

**Guidance for future changes:** keep topics restricted to static event-type symbols. If a data point is considered sensitive, exclude it from the emitted payload rather than from storage, and remember that event *data* — not just topics — is public to all observers.

---

## Cargo.toml Dependencies

The contract specifies minimal, optimized dependencies in [Cargo.toml](./Cargo.toml):

- **`soroban-sdk`**: The standard SDK for writing Smart Contracts on Stellar. The `alloc` feature enables dynamic allocation support. The `testutils` feature flag (enabled on the `soroban-sdk` dev-dependency) enables simulation, mocking, ledger manipulation, and event debugging inside the test environment.
- **`proptest`** (dev-dependency): Property-based testing framework used by `src/test.rs` to verify the contract's arithmetic and state-transition logic over many randomly generated inputs (e.g. conservation of funds across partial releases).

---

## Deployment & Invocation Guide

Follow these commands to build, deploy, and invoke the contract locally or on the testnet.

> **Note:** `stellar` is the current CLI binary name (`soroban` was its former name). Older tutorials may still show `soroban contract ...` — substitute `stellar contract ...` in those examples.

### 1. Build the Contract
Compile the Rust contract into optimized WebAssembly:
```bash
cargo build --target wasm32-unknown-unknown --release
# Alternatively, use stellar contract build (if toolchain is installed):
# stellar contract build
```

### 2. Deploy to Testnet
Deploy the contract to the Stellar testnet and retrieve the contract ID:
```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_payfi_escrow.wasm \
  --source-account my-keypair-name \
  --network testnet
```

### 3. Initialize Escrow (Example Command)
Lock 100 tokens with a future expiry timestamp (e.g. `1813689600`):
```bash
stellar contract invoke \
  --id CD_YOUR_CONTRACT_ID_HERE \
  --source-account depositor-keypair \
  --network testnet \
  -- \
  initialize \
  --depositor G_DEPOSITOR_ADDRESS \
  --recipient G_RECIPIENT_ADDRESS \
  --arbiter G_ARBITER_ADDRESS \
  --token C_TOKEN_CONTRACT_ADDRESS \
  --amount 1000000000 \
  --expiry 1813689600
```

### 4. Query Lifecycle State
```bash
stellar contract invoke \
  --id CD_YOUR_CONTRACT_ID_HERE \
  --source-account any-account \
  --network testnet \
  -- \
  get_state
```

### 5. Release Funds (by Arbiter)
```bash
stellar contract invoke \
  --id CD_YOUR_CONTRACT_ID_HERE \
  --source-account arbiter-keypair \
  --network testnet \
  -- \
  release \
  --arbiter G_ARBITER_ADDRESS
```

---

## Contract Upgrade Path

### Immutability Constraint

Soroban contracts are **immutable once deployed**. The escrow contract does not include an upgrade mechanism, meaning once deployed to mainnet, the contract code cannot be patched or modified. This is a fundamental design constraint of Soroban and ensures the security and predictability of deployed contracts.

### Upgrade Strategy

To deploy a new version of the escrow contract:

1. **Deploy a New Contract**: Build and deploy the updated contract to Soroban, which will generate a new contract ID.

2. **Migrate Active Escrows**: Transfer all active escrows from the old contract to the new contract:
   - **Manual Migration**: For each active escrow, call `refund()` on the old contract (if expired) or coordinate with the arbiter to release funds, then re-initialize on the new contract.
   - **Automated Migration Script**: Create a migration script that:
     - Reads all active escrow states from the old contract
     - Re-initializes each escrow on the new contract with the same parameters
     - Validates that all funds have been transferred correctly

3. **Update Contract Address Configuration**: Update the agent's configuration to reference the new contract address. This allows operators to swap contract addresses without code changes.

### Recommended Pattern: Configuration-Driven Addresses

To minimize downtime and simplify upgrades, store contract addresses in the agent's configuration file rather than hardcoding them:

```json
{
  "escrow_contract_address": "CD_CURRENT_CONTRACT_ID"
}
```

This approach allows operators to:
- Quickly switch to a new contract by updating the configuration
- Roll back to a previous contract if needed
- Test new contracts on testnet before mainnet deployment
- Avoid code deployments for contract address changes
