/*!
 * contracts/escrow/src/lib.rs
 *
 * PayFi Escrow Contract — Soroban (Stellar)
 *
 * Lifecycle:
 *   1. `initialize`  — depositor locks funds, sets arbiter + recipient + expiry
 *   2. `release`     — arbiter releases funds to recipient
 *   3. `refund`      — depositor reclaims after expiry
 *
 * Security invariants:
 *   - Only the arbiter can call `release`
 *   - Only the depositor can call `refund`, and only after expiry
 *   - State transitions are enforced (no double-release / double-refund)
 *
 * Formal verification annotations:
 *   The `//@ requires` / `//@ ensures` comment blocks above each public
 *   function are machine-readable specifications for formal verification
 *   tooling. Vocabulary used by the annotations:
 *   - `requires`        — preconditions; a violation panics with the error
 *                         documented in the function's `# Panics` section.
 *   - `ensures`         — postconditions that hold when the function returns.
 *   - `old(x)`          — the value of `x` in the pre-call state.
 *   - `stored_<field>`  — value read from instance storage under the matching
 *                         `DataKey` (e.g. `stored_amount` == `DataKey::Amount`).
 *   - `ledger_timestamp`— `env.ledger().timestamp()` at call time.
 *   - `has(Key)`        — the instance-storage key exists.
 *   - `result`          — the function's return value.
 *   Contract-level `//@ invariant` lines above the impl must hold on every
 *   entry into and exit from the contract.
 */

#![cfg_attr(not(test), no_std)]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error,
    token::Client as TokenClient, Address, BytesN, Env, Symbol,
};

// ─── Security constants ───────────────────────────────────────────────────────

/// Minimum delay (in seconds) that must elapse between proposing an arbiter
/// rotation and accepting it (24 hours).
///
/// This is the security-critical floor for `accept_arbiter_rotation`: it is a
/// hard-coded constant, never caller-supplied or read from storage, so no
/// party — depositor or otherwise — can shorten the hostile-takeover window
/// below this value. Keep any future configurability above this constant and
/// reject proposals requesting less than `MIN_ROTATION_DELAY`.
pub const MIN_ROTATION_DELAY: u64 = 86_400; // 24 hours in seconds

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Depositor,
    Recipient,
    Arbiter,
    Token,
    Amount,
    Expiry,
    Released,
    InitializedAt,
    PendingArbiter,
    PendingArbiterTime,
}

// ─── Escrow State ─────────────────────────────────────────────────────────────

#[contracttype]
pub struct EscrowState {
    pub depositor: Address,
    pub recipient: Address,
    pub arbiter: Address,
    pub token: Address,
    pub amount: i128,
    pub expiry: u64,
    pub released: bool,
    pub initialized_at: u64,
}

// ─── Contract Errors ──────────────────────────────────────────────────────────

/// Errors that can be returned by the escrow contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum EscrowError {
    /// The escrow contract is already initialised.
    AlreadyInitialized = 1,
    /// The funds have already been released or refunded.
    AlreadyReleased = 2,
    /// The escrow has not yet expired.
    NotExpired = 3,
    /// The caller is not the authorized arbiter.
    NotArbiter = 4,
    /// The caller is not the authorized depositor.
    NotDepositor = 5,
    /// The transfer amount must be positive.
    InvalidAmount = 6,
    /// The expiry timestamp must be in the future.
    InvalidExpiry = 7,
    /// The escrow has not been initialized yet.
    NotInitialized = 8,
    /// depositor, recipient, and arbiter must all be distinct addresses.
    InvalidParties = 9,
    /// The arbiter rotation time-lock has not yet expired.
    RotationLocked = 10,
    /// No pending arbiter rotation proposal.
    NoPendingRotation = 11,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

// ─── Contract invariants (formal verification) ───────────────────────────────
//@ invariant stored_amount >= 0
//@ invariant stored_amount == 0 ==> stored_released == true
//@ invariant stored_released ==> contract_token_balance == 0
//@ invariant !stored_released ==> contract_token_balance == stored_amount

#[contractimpl]
impl EscrowContract {
    /// Initialise the escrow and transfer funds from depositor to contract.
    ///
    /// # Arguments
    /// * `env`       - The execution environment.
    /// * `depositor` - Party locking the funds.
    /// * `recipient` - Party who receives funds on release.
    /// * `arbiter`   - Trusted party who authorises release.
    /// * `token`     - SAC token contract address. **Only Stellar Asset Contract (SAC) tokens
    ///                 conforming to the Stellar token interface are supported.** Non-SAC tokens
    ///                 with incompatible interfaces will cause a panic. Verify the token address
    ///                 is a SAC before calling initialize() by checking the token's contract code
    ///                 or attempting to read its decimals().
    /// * `amount`    - Token amount (stroop-equivalent units).
    /// * `expiry`    - Unix timestamp after which depositor may refund.
    ///
    /// # Panics
    /// * `AlreadyInitialized` - If the escrow has already been initialised.
    /// * `InvalidParties` - If depositor, recipient, and arbiter are not all distinct.
    /// * `InvalidAmount` - If amount is not positive.
    /// * `InvalidExpiry` - If expiry is not in the future.
    ///
    /// # Return Value
    /// None.
    //@ requires !has(Depositor)
    //@ requires depositor != arbiter && depositor != recipient && arbiter != recipient
    //@ requires amount > 0 && amount <= i128::MAX / 2
    //@ requires expiry > ledger_timestamp
    //@ ensures has(Depositor) && has(Recipient) && has(Arbiter) && has(Token) && has(Amount) && has(Expiry) && has(Released)
    //@ ensures stored_depositor == depositor
    //@ ensures stored_recipient == recipient
    //@ ensures stored_arbiter == arbiter
    //@ ensures stored_token == token
    //@ ensures stored_amount == amount
    //@ ensures stored_expiry == expiry
    //@ ensures stored_released == false
    //@ ensures depositor_token_balance == old(depositor_token_balance) - amount
    //@ ensures contract_token_balance == old(contract_token_balance) + amount
    pub fn initialize(
        env: Env,
        depositor: Address,
        recipient: Address,
        arbiter: Address,
        token: Address,
        amount: i128,
        expiry: u64,
    ) {
        // Prevent re-initialisation
        if env.storage().instance().has(&DataKey::Depositor) {
            panic_with_error!(&env, EscrowError::AlreadyInitialized);
        }

        depositor.require_auth();

        // Parties must all be distinct — a depositor who is also the arbiter
        // could release funds to themselves, defeating the escrow purpose.
        if depositor == arbiter {
            panic_with_error!(&env, EscrowError::InvalidParties);
        }
        if depositor == recipient {
            panic_with_error!(&env, EscrowError::InvalidParties);
        }
        if arbiter == recipient {
            panic_with_error!(&env, EscrowError::InvalidParties);
        }

        // Ensure amount is positive and within a safe range to avoid overflow in token transfers.
        if amount <= 0 {
            panic_with_error!(&env, EscrowError::InvalidAmount);
        }
        // Guard against amounts that could overflow when added to existing balances.
        if amount > i128::MAX / 2 {
            panic_with_error!(&env, EscrowError::InvalidAmount);
        }
        if expiry <= env.ledger().timestamp() {
            panic_with_error!(&env, EscrowError::InvalidExpiry);
        }

        // Pull funds from depositor
        TokenClient::new(&env, &token).transfer(
            &depositor,
            &env.current_contract_address(),
            &amount,
        );

        // Persist state
        let now = env.ledger().timestamp();
        env.storage()
            .instance()
            .set(&DataKey::Depositor, &depositor);
        env.storage()
            .instance()
            .set(&DataKey::Recipient, &recipient);
        env.storage().instance().set(&DataKey::Arbiter, &arbiter);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Amount, &amount);
        env.storage().instance().set(&DataKey::Expiry, &expiry);
        env.storage().instance().set(&DataKey::Released, &false);
        env.storage()
            .instance()
            .set(&DataKey::InitializedAt, &now);

        env.events().publish(
            (
                Symbol::new(&env, "escrow"),
                Symbol::new(&env, "initialized"),
            ),
            (depositor.clone(), recipient.clone(), amount),
        );
    }

    /// Release funds to the recipient. Only callable by the stored arbiter.
    ///
    /// # Arguments
    /// * `env`     - The execution environment.
    /// * `arbiter` - Must match the arbiter recorded at initialisation.
    ///
    /// # Panics
    /// * `NotArbiter` - If caller is not the stored arbiter.
    /// * `AlreadyReleased` - If funds have already been released or refunded.
    ///
    /// # Return Value
    /// None.
    //@ requires has(Depositor)
    //@ requires arbiter == stored_arbiter
    //@ requires !stored_released
    //@ ensures stored_released == true
    //@ ensures stored_amount == old(stored_amount)
    //@ ensures recipient_token_balance == old(recipient_token_balance) + old(stored_amount)
    //@ ensures contract_token_balance == old(contract_token_balance) - old(stored_amount)
    pub fn release(env: Env, arbiter: Address) {
        // Read stored arbiter first, then authenticate against it (fixes TOCTOU).
        let stored_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbiter)
            .expect("escrow: state corrupted");
        stored_arbiter.require_auth();
        if arbiter != stored_arbiter {
            panic_with_error!(&env, EscrowError::NotArbiter);
        }

        Self::assert_not_released(&env);

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("escrow: state corrupted");
        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .expect("escrow: state corrupted");
        let recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::Recipient)
            .expect("escrow: state corrupted");

        env.storage().instance().set(&DataKey::Released, &true);

        // Transfer to stored_recipient (read from storage), not the caller parameter.
        // This is the intentional pattern: destination always comes from storage,
        // never from a caller-supplied argument, to prevent TOCTOU-style substitution.
        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );

        env.events().publish(
            (
                Symbol::new(&env, "escrow"),
                Symbol::new(&env, "released"),
            ),
            (recipient, amount),
        );
    }

    /// Refund depositor after expiry. Only callable by the stored depositor.
    ///
    /// # Arguments
    /// * `env`       - The execution environment.
    /// * `depositor` - Must match the depositor recorded at initialisation.
    ///
    /// # Panics
    /// * `NotDepositor` - If caller is not the stored depositor.
    /// * `AlreadyReleased` - If funds have already been released or refunded.
    /// * `NotExpired` - If contract is not yet expired.
    ///
    /// # Return Value
    /// None.
    //@ requires has(Depositor)
    //@ requires depositor == stored_depositor
    //@ requires !stored_released
    //@ requires ledger_timestamp >= stored_expiry
    //@ ensures stored_released == true
    //@ ensures depositor_token_balance == old(depositor_token_balance) + old(stored_amount)
    //@ ensures contract_token_balance == old(contract_token_balance) - old(stored_amount)
    pub fn refund(env: Env, depositor: Address) {
        // Read stored depositor first, then authenticate against it (fixes TOCTOU).
        let stored_depositor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Depositor)
            .expect("escrow: state corrupted");
        stored_depositor.require_auth();
        if depositor != stored_depositor {
            panic_with_error!(&env, EscrowError::NotDepositor);
        }

        Self::assert_not_released(&env);

        let expiry: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Expiry)
            .expect("escrow: state corrupted");
        if env.ledger().timestamp() < expiry {
            panic_with_error!(&env, EscrowError::NotExpired);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("escrow: state corrupted");
        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .expect("escrow: state corrupted");

        env.storage().instance().set(&DataKey::Released, &true);

        // Transfer to stored_depositor (read from storage), not the caller parameter.
        // This mirrors the pattern used in `release`, which transfers to stored_recipient,
        // ensuring the destination is always the address recorded at initialization.
        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &stored_depositor,
            &amount,
        );

        env.events()
            .publish((Symbol::new(&env, "refunded"),), (stored_depositor, amount));
    }

    /// Return a snapshot of all escrow fields. Panics if not yet initialized.
    ///
    /// # Arguments
    /// * `env` - The execution environment.
    ///
    /// # Panics
    /// * `NotInitialized` - If called before `initialize`.
    ///
    /// # Return Value
    /// Returns `EscrowState` with all stored fields.
    //@ requires has(Depositor)
    //@ ensures result == EscrowState { depositor: stored_depositor, recipient: stored_recipient, arbiter: stored_arbiter, token: stored_token, amount: stored_amount, expiry: stored_expiry, released: stored_released }
    pub fn get_state(env: Env) -> EscrowState {
        if !env.storage().instance().has(&DataKey::Depositor) {
            panic_with_error!(&env, EscrowError::NotInitialized);
        }
        EscrowState {
            depositor: env
                .storage()
                .instance()
                .get(&DataKey::Depositor)
                .expect("escrow: state corrupted"),
            recipient: env
                .storage()
                .instance()
                .get(&DataKey::Recipient)
                .expect("escrow: state corrupted"),
            arbiter: env
                .storage()
                .instance()
                .get(&DataKey::Arbiter)
                .expect("escrow: state corrupted"),
            token: env
                .storage()
                .instance()
                .get(&DataKey::Token)
                .expect("escrow: state corrupted"),
            amount: env
                .storage()
                .instance()
                .get(&DataKey::Amount)
                .expect("escrow: state corrupted"),
            expiry: env
                .storage()
                .instance()
                .get(&DataKey::Expiry)
                .expect("escrow: state corrupted"),
            released: env
                .storage()
                .instance()
                .get(&DataKey::Released)
                .unwrap_or(false),
            initialized_at: env
                .storage()
                .instance()
                .get(&DataKey::InitializedAt)
                .expect("escrow: state corrupted"),
        }
    }

    /// Release a partial amount of locked funds to the recipient. Only callable by the stored arbiter.
    ///
    /// Enables milestone-based PayFi contracts (e.g., 50% on delivery confirmation,
    /// 50% on final acceptance). The escrow remains active (`Released = false`) until
    /// the remaining stored amount reaches 0, at which point it is sealed.
    ///
    /// # Arguments
    /// * `env`            - The execution environment.
    /// * `arbiter`        - Must match the arbiter recorded at initialisation.
    /// * `release_amount` - Number of token units to transfer to the recipient.
    ///
    /// # Panics
    /// * `NotArbiter` - If the caller is not the stored arbiter.
    /// * `AlreadyReleased` - If the escrow has already been fully settled.
    /// * `InvalidAmount` - If `release_amount` is not positive or exceeds the stored amount.
    ///
    /// # Return Value
    /// None. Emits a `"partial_released"` event (or `"released"` on final settlement).
    //@ requires has(Depositor)
    //@ requires arbiter == stored_arbiter
    //@ requires !stored_released
    //@ requires release_amount > 0 && release_amount <= stored_amount
    //@ ensures stored_amount == old(stored_amount) - release_amount
    //@ ensures stored_released == (stored_amount == 0)
    //@ ensures recipient_token_balance == old(recipient_token_balance) + release_amount
    //@ ensures contract_token_balance == old(contract_token_balance) - release_amount
    pub fn release_partial(env: Env, arbiter: Address, release_amount: i128) {
        // Read stored arbiter and authenticate (consistent TOCTOU fix from release())
        let stored_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbiter)
            .expect("escrow: state corrupted");
        stored_arbiter.require_auth();
        if arbiter != stored_arbiter {
            panic_with_error!(&env, EscrowError::NotArbiter);
        }

        Self::assert_not_released(&env);

        // Validate release_amount
        let stored_amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .expect("escrow: state corrupted");

        if release_amount <= 0 || release_amount > stored_amount {
            panic_with_error!(&env, EscrowError::InvalidAmount);
        }

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("escrow: state corrupted");
        let recipient: Address = env
            .storage()
            .instance()
            .get(&DataKey::Recipient)
            .expect("escrow: state corrupted");

        let remaining = stored_amount - release_amount;

        // Update stored amount to reflect partial release
        env.storage()
            .instance()
            .set(&DataKey::Amount, &remaining);

        // Transfer the partial amount to the recipient
        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &recipient,
            &release_amount,
        );

        if remaining == 0 {
            // All funds distributed — seal the escrow
            env.storage().instance().set(&DataKey::Released, &true);
            env.events()
                .publish((Symbol::new(&env, "released"),), (recipient.clone(), release_amount));
        } else {
            env.events().publish(
                (Symbol::new(&env, "partial_released"),),
                (recipient, release_amount, remaining),
            );
        }
    }

    /// Cancel the escrow cooperatively. Requires both depositor and arbiter to authorise.
    ///
    /// # Arguments
    /// * `env`       - The execution environment.
    /// * `depositor` - Must match the depositor recorded at initialisation.
    /// * `arbiter`   - Must match the arbiter recorded at initialisation.
    ///
    /// # Panics
    /// * `NotDepositor` - If the depositor parameter does not match stored depositor.
    /// * `NotArbiter` - If the arbiter parameter does not match stored arbiter.
    /// * `AlreadyReleased` - If funds have already been released, refunded, or cancelled.
    ///
    /// # Return Value
    /// None.
    //@ requires has(Depositor)
    //@ requires depositor == stored_depositor
    //@ requires arbiter == stored_arbiter
    //@ requires !stored_released
    //@ ensures stored_released == true
    //@ ensures depositor_token_balance == old(depositor_token_balance) + old(stored_amount)
    //@ ensures contract_token_balance == old(contract_token_balance) - old(stored_amount)
    pub fn cancel(env: Env, depositor: Address, arbiter: Address) {
        let stored_depositor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Depositor)
            .expect("escrow: state corrupted");
        let stored_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::Arbiter)
            .expect("escrow: state corrupted");

        // Dual-signature: both parties must authorise before any state mutation.
        stored_depositor.require_auth();
        stored_arbiter.require_auth();

        if depositor != stored_depositor {
            panic_with_error!(&env, EscrowError::NotDepositor);
        }
        if arbiter != stored_arbiter {
            panic_with_error!(&env, EscrowError::NotArbiter);
        }

        Self::assert_not_released(&env);

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .expect("escrow: state corrupted");
        let amount: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Amount)
            .expect("escrow: state corrupted");

        env.storage().instance().set(&DataKey::Released, &true);

        TokenClient::new(&env, &token).transfer(
            &env.current_contract_address(),
            &stored_depositor,
            &amount,
        );

        env.events().publish(
            (
                Symbol::new(&env, "escrow"),
                Symbol::new(&env, "cancelled"),
            ),
            (stored_depositor, amount),
        );
    }

    /// Propose a new arbiter. Only callable by the stored depositor.
    ///
    /// Initiates a time-locked arbiter rotation to prevent instant hostile takeover.
    /// The proposal is locked for at least `MIN_ROTATION_DELAY` (24 hours) seconds;
    /// only after that floor elapses can `accept_arbiter_rotation` finalize the change.
    /// This minimum is enforced by the contract, not chosen by the caller, so no
    /// proposal can solicit a near-instant rotation.
    ///
    /// # Arguments
    /// * `env`        - The execution environment.
    /// * `depositor`  - Must match the depositor recorded at initialisation.
    /// * `new_arbiter` - The proposed new arbiter address.
    ///
    /// # Panics
    /// * `NotDepositor` - If the caller is not the stored depositor.
    /// * `NotInitialized` - If the escrow has not been initialized.
    ///
    /// # Return Value
    /// None.
    pub fn propose_new_arbiter(env: Env, depositor: Address, new_arbiter: Address) {
        let stored_depositor: Address = env
            .storage()
            .instance()
            .get(&DataKey::Depositor)
            .expect("escrow: state corrupted");
        stored_depositor.require_auth();
        if depositor != stored_depositor {
            panic_with_error!(&env, EscrowError::NotDepositor);
        }

        let now = env.ledger().timestamp();
        env.storage()
            .instance()
            .set(&DataKey::PendingArbiter, &new_arbiter);
        env.storage()
            .instance()
            .set(&DataKey::PendingArbiterTime, &now);

        env.events().publish(
            (Symbol::new(&env, "arbiter_rotation_proposed"),),
            (depositor, new_arbiter, now),
        );
    }

    /// Accept the pending arbiter rotation after the minimum time-lock.
    ///
    /// Finalizes the arbiter change if at least `MIN_ROTATION_DELAY` (24 hours)
    /// have passed since `propose_new_arbiter` was called. Can be called by anyone
    /// once the time-lock has expired.
    ///
    /// # Arguments
    /// * `env` - The execution environment.
    ///
    /// # Panics
    /// * `NoPendingRotation` - If no arbiter rotation has been proposed.
    /// * `RotationLocked` - If the 24-hour time-lock has not yet elapsed.
    ///
    /// # Return Value
    /// None.
    pub fn accept_arbiter_rotation(env: Env) {
        if !env.storage().instance().has(&DataKey::PendingArbiter) {
            panic_with_error!(&env, EscrowError::NoPendingRotation);
        }

        let pending_time: u64 = env
            .storage()
            .instance()
            .get(&DataKey::PendingArbiterTime)
            .expect("escrow: state corrupted");
        let now = env.ledger().timestamp();

        // The minimum rotation delay is a fixed constant, so no caller-controlled
        // duration can ever shorten it. Use checked addition so an overflow cannot
        // wrap around and accidentally unlock the rotation early.
        let lock_expires = pending_time
            .checked_add(MIN_ROTATION_DELAY)
            .expect("escrow: rotation deadline overflow");

        if now < lock_expires {
            panic_with_error!(&env, EscrowError::RotationLocked);
        }

        let new_arbiter: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingArbiter)
            .expect("escrow: state corrupted");

        env.storage().instance().set(&DataKey::Arbiter, &new_arbiter);
        env.storage()
            .instance()
            .remove(&DataKey::PendingArbiter);
        env.storage()
            .instance()
            .remove(&DataKey::PendingArbiterTime);

        env.events().publish(
            (Symbol::new(&env, "arbiter_rotation_accepted"),),
            (new_arbiter, now),
        );
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    fn assert_not_released(env: &Env) {
        let released: bool = env
            .storage()
            .instance()
            .get(&DataKey::Released)
            .unwrap_or(false);
        if released {
            panic_with_error!(env, EscrowError::AlreadyReleased);
        }
    }
}

#[cfg(test)]
mod test;
