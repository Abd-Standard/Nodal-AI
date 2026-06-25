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
 */

#![cfg_attr(not(test), no_std)]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error,
    token::Client as TokenClient, Address, Env, Symbol,
};

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
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct EscrowContract;

#[contractimpl]
impl EscrowContract {
    /// Initialise the escrow and transfer funds from depositor to contract.
    ///
    /// # Arguments
    /// * `env`       - The execution environment.
    /// * `depositor` - Party locking the funds.
    /// * `recipient` - Party who receives funds on release.
    /// * `arbiter`   - Trusted party who authorises release.
    /// * `token`     - SAC token contract address.
    /// * `amount`    - Token amount (stroop-equivalent units).
    /// * `expiry`    - Unix timestamp after which depositor may refund.
    ///
    /// # Panics
    /// * `AlreadyInitialized` - If the escrow has already been initialised.
    /// * `InvalidAmount` - If amount is not positive.
    /// * `InvalidExpiry` - If expiry is not in the future.
    ///
    /// # Return Value
    /// None.
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

        if amount <= 0 {
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

        env.events().publish(
            (Symbol::new(&env, "initialized"),),
            (depositor, recipient, amount),
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

        env.events()
            .publish((Symbol::new(&env, "released"),), (recipient, amount));
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

        env.events()
            .publish((Symbol::new(&env, "cancelled"),), (stored_depositor, amount));
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
