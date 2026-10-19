/*!
 * contracts/agent_policy/src/lib.rs
 *
 * Agent Spending-Policy Account — Soroban (Stellar) — PROTOTYPE (issue #813)
 *
 * A custom account contract that holds the agent's funds and only lets the
 * agent's ed25519 key spend up to `limit` token units per rolling `window`
 * seconds. The limit lives in `__check_auth`, so it is enforced by the
 * network itself: a stolen agent key or a compromised Node process cannot
 * exceed it. See docs/design/onchain-policy.md for the design rationale and
 * the OpenZeppelin smart-account comparison.
 *
 * Lifecycle:
 *   1. `init`       — owner deploys + configures (agent key, token, limit, window)
 *   2. agent signs  — any tx that needs this account's auth runs `__check_auth`
 *   3. `set_policy` — owner (separate key) can raise/lower the limit
 *
 * Security invariants:
 *   - Every authorised value-moving call (`transfer`, `transfer_from`,
 *     `approve`, `burn`, `burn_from`) on the policy token is counted against
 *     the current window; the window total never exceeds `limit`.
 *   - Value-moving calls on any other token are rejected (deny by default).
 *   - The agent key can never authorise calls to this contract itself, nor
 *     contract deployments, so it cannot rewrite its own policy.
 *   - Only `owner` can change the policy.
 */

#![cfg_attr(not(test), no_std)]
#![allow(unexpected_cfgs)]

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short,
    Address, BytesN, Env, Symbol, TryIntoVal, Val, Vec,
};

// ─── Storage keys ─────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    AgentKey,
    Owner,
    Token,
    Limit,
    Window,
    WindowStart,
    Spent,
}

// ─── Policy State ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyState {
    pub owner: Address,
    pub token: Address,
    pub limit: i128,
    pub window: u64,
    pub window_start: u64,
    pub spent: i128,
}

// ─── Contract Errors ──────────────────────────────────────────────────────────

/// Errors that can be returned by the policy account.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub enum PolicyError {
    /// The account has already been initialised.
    AlreadyInitialized = 1,
    /// The account has not been initialised yet.
    NotInitialized = 2,
    /// `limit` must be positive and `window` non-zero.
    InvalidPolicy = 3,
    /// The spend would push the current window over `limit`.
    OverLimit = 4,
    /// The agent key is not allowed to authorise this call.
    ForbiddenContext = 5,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct AgentPolicyAccount;

#[contractimpl]
impl AgentPolicyAccount {
    /// Configure the account.
    ///
    /// # Arguments
    /// * `agent_key` - ed25519 public key the Node agent signs with.
    /// * `owner`     - Separate (ideally cold / multisig) address that may change the policy.
    /// * `token`     - SAC token the limit applies to.
    /// * `limit`     - Maximum token units spendable per window.
    /// * `window`    - Window length in seconds.
    ///
    /// # Panics
    /// * `AlreadyInitialized` - If called twice.
    /// * `InvalidPolicy` - If `limit <= 0` or `window == 0`.
    pub fn init(
        env: Env,
        agent_key: BytesN<32>,
        owner: Address,
        token: Address,
        limit: i128,
        window: u64,
    ) {
        if env.storage().instance().has(&DataKey::AgentKey) {
            panic_with_error!(&env, PolicyError::AlreadyInitialized);
        }
        owner.require_auth();
        if limit <= 0 || window == 0 {
            panic_with_error!(&env, PolicyError::InvalidPolicy);
        }

        let now = env.ledger().timestamp();
        env.storage().instance().set(&DataKey::AgentKey, &agent_key);
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Limit, &limit);
        env.storage().instance().set(&DataKey::Window, &window);
        env.storage().instance().set(&DataKey::WindowStart, &now);
        env.storage().instance().set(&DataKey::Spent, &0i128);

        env.events().publish(
            (Symbol::new(&env, "policy"), Symbol::new(&env, "initialized")),
            (owner, token, limit, window),
        );
    }

    /// Change the spending limit and window. Only callable by the owner.
    ///
    /// The amount already spent in the current window is kept, so lowering
    /// the limit takes effect immediately.
    ///
    /// # Panics
    /// * `NotInitialized` - If called before `init`.
    /// * `InvalidPolicy` - If `limit <= 0` or `window == 0`.
    pub fn set_policy(env: Env, limit: i128, window: u64) {
        let owner = Self::owner(&env);
        owner.require_auth();
        if limit <= 0 || window == 0 {
            panic_with_error!(&env, PolicyError::InvalidPolicy);
        }
        env.storage().instance().set(&DataKey::Limit, &limit);
        env.storage().instance().set(&DataKey::Window, &window);

        env.events().publish(
            (Symbol::new(&env, "policy"), Symbol::new(&env, "updated")),
            (limit, window),
        );
    }

    /// Return the current policy and window accounting.
    ///
    /// # Panics
    /// * `NotInitialized` - If called before `init`.
    pub fn get_policy(env: Env) -> PolicyState {
        PolicyState {
            owner: Self::owner(&env),
            token: env
                .storage()
                .instance()
                .get(&DataKey::Token)
                .expect("policy: state corrupted"),
            limit: env
                .storage()
                .instance()
                .get(&DataKey::Limit)
                .expect("policy: state corrupted"),
            window: env
                .storage()
                .instance()
                .get(&DataKey::Window)
                .expect("policy: state corrupted"),
            window_start: env
                .storage()
                .instance()
                .get(&DataKey::WindowStart)
                .expect("policy: state corrupted"),
            spent: env
                .storage()
                .instance()
                .get(&DataKey::Spent)
                .expect("policy: state corrupted"),
        }
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    fn owner(env: &Env) -> Address {
        match env.storage().instance().get(&DataKey::Owner) {
            Some(owner) => owner,
            None => panic_with_error!(env, PolicyError::NotInitialized),
        }
    }

    /// Amount moved out of this account by a token call, or `None` when the
    /// function does not move value. The argument index follows the SEP-41
    /// token interface.
    fn spend_amount(env: &Env, fn_name: &Symbol, args: &Vec<Val>) -> Option<i128> {
        let index: u32 = if *fn_name == symbol_short!("burn") {
            1
        } else if *fn_name == symbol_short!("transfer")
            || *fn_name == symbol_short!("approve")
            || *fn_name == symbol_short!("burn_from")
        {
            2
        } else if *fn_name == Symbol::new(env, "transfer_from") {
            3
        } else {
            return None;
        };
        // A malformed argument list is treated as an unbounded spend so it
        // can never slip past the limit.
        Some(
            args.get(index)
                .and_then(|v| v.try_into_val(env).ok())
                .unwrap_or(i128::MAX),
        )
    }
}

#[contractimpl]
impl CustomAccountInterface for AgentPolicyAccount {
    type Signature = BytesN<64>;
    type Error = PolicyError;

    /// Authenticate the agent signature, then enforce the spending policy over
    /// every invocation being authorised.
    #[allow(non_snake_case)]
    fn __check_auth(
        env: Env,
        signature_payload: BytesN<32>,
        signature: BytesN<64>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), PolicyError> {
        let agent_key: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::AgentKey)
            .ok_or(PolicyError::NotInitialized)?;
        // Panics (rejecting the tx) if the signature is not from the agent key.
        env.crypto()
            .ed25519_verify(&agent_key, &signature_payload.into(), &signature);

        let token: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(PolicyError::NotInitialized)?;
        let self_address = env.current_contract_address();

        let mut total: i128 = 0;
        for context in auth_contexts.iter() {
            let call = match context {
                Context::Contract(call) => call,
                // The agent key may not deploy contracts on the account's behalf.
                Context::CreateContractHostFn(_) => return Err(PolicyError::ForbiddenContext),
            };
            // The agent key may never call this account directly (e.g. to
            // reconfigure it); policy changes go through `owner`.
            if call.contract == self_address {
                return Err(PolicyError::ForbiddenContext);
            }
            if let Some(amount) = Self::spend_amount(&env, &call.fn_name, &call.args) {
                // Deny value movement of any asset the policy does not cover.
                if call.contract != token || amount < 0 {
                    return Err(PolicyError::ForbiddenContext);
                }
                total = total.checked_add(amount).ok_or(PolicyError::OverLimit)?;
            }
        }

        if total == 0 {
            return Ok(());
        }

        let limit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Limit)
            .ok_or(PolicyError::NotInitialized)?;
        let window: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Window)
            .ok_or(PolicyError::NotInitialized)?;
        let mut window_start: u64 = env
            .storage()
            .instance()
            .get(&DataKey::WindowStart)
            .ok_or(PolicyError::NotInitialized)?;
        let mut spent: i128 = env
            .storage()
            .instance()
            .get(&DataKey::Spent)
            .ok_or(PolicyError::NotInitialized)?;

        // Fixed (tumbling) window: once it has elapsed, start a new one.
        let now = env.ledger().timestamp();
        if now >= window_start.saturating_add(window) {
            window_start = now;
            spent = 0;
        }

        let new_spent = spent.checked_add(total).ok_or(PolicyError::OverLimit)?;
        if new_spent > limit {
            return Err(PolicyError::OverLimit);
        }

        env.storage()
            .instance()
            .set(&DataKey::WindowStart, &window_start);
        env.storage().instance().set(&DataKey::Spent, &new_spent);
        Ok(())
    }
}

#[cfg(test)]
mod test;
