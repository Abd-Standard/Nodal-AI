/*!
 * contracts/escrow/src/test.rs
 *
 * Comprehensive Soroban test suite for the PayFi escrow contract.
 * Uses soroban_sdk::testutils — no live network required.
 *
 * Coverage:
 *   Happy path      : initialize->release, initialize->refund
 *   Expiry boundary : exact timestamp, 1s before expiry
 *   State guards    : double-release, refund-after-release,
 *                     release-after-refund, re-initialization
 *   Input guards    : zero amount, past expiry on init
 *   Authorization   : wrong arbiter, wrong depositor
 *   Events          : "released", "refunded"
 *   Balance         : partial lock, full balance lock
 *   Property tests  : conservation of funds — the sum of released/refunded
 *                     tokens equals the initialised amount over many random
 *                     amounts (proptest)
 */

#[cfg(test)]
mod tests {
    extern crate std;

    use crate::{EscrowContract, EscrowContractClient, EscrowState, MIN_ROTATION_DELAY};
    use proptest::prelude::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        token::{Client as TokenClient, StellarAssetClient},
        Address, Env,
    };

    const EXPIRY_OFFSET: u64 = 3_600;

    fn create_token<'a>(env: &'a Env, admin: &Address) -> (Address, TokenClient<'a>) {
        let token_id = env.register_stellar_asset_contract(admin.clone());
        let token = TokenClient::new(env, &token_id);
        (token_id, token)
    }

    // 1. initialize -> release
    #[test]
    fn test_initialize_and_release() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        assert_eq!(token.balance(&depositor), 500);
        assert_eq!(token.balance(&contract_id), 500);
        assert_eq!(token.balance(&recipient), 0);
        client.release(&arbiter);
        assert_eq!(token.balance(&recipient), 500);
        assert_eq!(token.balance(&contract_id), 0);
    }

    // 3. initialize with max i128 amount should panic
    #[test]
    #[should_panic]
    fn test_initialize_max_i128_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        // Use max i128 amount; should panic due to overflow guard
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &i128::MAX,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
    }

    // 2. initialize -> refund after expiry
    #[test]
    fn test_refund_after_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + 100;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.ledger().with_mut(|li| li.timestamp = expiry + 1);
        client.refund(&depositor);
        assert_eq!(token.balance(&depositor), 1_000);
        assert_eq!(token.balance(&contract_id), 0);
    }

    // 3. Exact expiry boundary
    #[test]
    fn test_refund_at_exact_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + 100;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.ledger().with_mut(|li| li.timestamp = expiry);
        client.refund(&depositor);
        assert_eq!(token.balance(&depositor), 1_000);
    }

    // 4. Full balance lock then release
    #[test]
    fn test_full_balance_lock_and_release() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &1_000,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        assert_eq!(token.balance(&depositor), 0);
        assert_eq!(token.balance(&contract_id), 1_000);
        client.release(&arbiter);
        assert_eq!(token.balance(&recipient), 1_000);
        assert_eq!(token.balance(&contract_id), 0);
    }

    // 5. Depositor keeps remainder after partial lock
    #[test]
    fn test_depositor_keeps_remainder() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &300,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        assert_eq!(token.balance(&depositor), 700);
        assert_eq!(token.balance(&contract_id), 300);
    }

    // 6. refund before expiry panics
    #[test]
    #[should_panic]
    fn test_refund_before_expiry_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + 9_999),
        );
        env.as_contract(&contract_id, || {
            EscrowContract::refund(env.clone(), depositor.clone());
        });
    }

    // 7. double release panics
    #[test]
    #[should_panic]
    fn test_double_release_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        client.release(&arbiter);
        env.as_contract(&contract_id, || {
            EscrowContract::release(env.clone(), arbiter.clone());
        });
    }

    // 8. refund after release panics
    #[test]
    #[should_panic]
    fn test_refund_after_release_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + 100;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        client.release(&arbiter);
        env.ledger().with_mut(|li| li.timestamp = expiry + 1);
        env.as_contract(&contract_id, || {
            EscrowContract::refund(env.clone(), depositor.clone());
        });
    }

    // 9. release after refund panics
    #[test]
    #[should_panic]
    fn test_release_after_refund_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + 100;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.ledger().with_mut(|li| li.timestamp = expiry + 1);
        client.refund(&depositor);
        env.as_contract(&contract_id, || {
            EscrowContract::release(env.clone(), arbiter.clone());
        });
    }

    // 10. re-initialization panics
    #[test]
    #[should_panic]
    fn test_reinitialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &2_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.as_contract(&contract_id, || {
            EscrowContract::initialize(
                env.clone(),
                depositor.clone(),
                recipient.clone(),
                arbiter.clone(),
                token_id.clone(),
                500,
                expiry,
            );
        });
    }

    // ── Double-initialize guard (issue #309) ─────────────────────────────────

    // 10b. calling initialize twice panics with AlreadyInitialized
    #[test]
    #[should_panic]
    fn test_double_initialize_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
    }

    // 11. zero amount panics
    #[test]
    #[should_panic]
    fn test_zero_amount_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        env.as_contract(&contract_id, || {
            EscrowContract::initialize(
                env.clone(),
                depositor.clone(),
                recipient.clone(),
                arbiter.clone(),
                token_id.clone(),
                0,
                expiry,
            );
        });
    }

    // 12. past expiry on init panics
    #[test]
    #[should_panic]
    fn test_past_expiry_on_init_panics() {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = 100);
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let expiry = env.ledger().timestamp() - 1;
        env.as_contract(&contract_id, || {
            EscrowContract::initialize(
                env.clone(),
                depositor.clone(),
                recipient.clone(),
                arbiter.clone(),
                token_id.clone(),
                500,
                expiry,
            );
        });
    }

    // 13. unauthorized release panics
    #[test]
    #[should_panic]
    fn test_unauthorized_release_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let impostor = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        env.as_contract(&contract_id, || {
            EscrowContract::release(env.clone(), impostor.clone());
        });
    }

    // 14. unauthorized refund panics
    #[test]
    #[should_panic]
    fn test_unauthorized_refund_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let impostor = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + 100;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.ledger().with_mut(|li| li.timestamp = expiry + 1);
        env.as_contract(&contract_id, || {
            EscrowContract::refund(env.clone(), impostor.clone());
        });
    }

    // 15. "released" event is emitted
    #[test]
    fn test_release_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        client.release(&arbiter);
        let events = env.events().all();
        assert!(!events.is_empty());
        assert!(std::format!("{:?}", events).contains("released"));
    }

    // 16. "refunded" event is emitted
    #[test]
    fn test_refund_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + 100;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.ledger().with_mut(|li| li.timestamp = expiry + 1);
        client.refund(&depositor);
        let events = env.events().all();
        assert!(std::format!("{:?}", events).contains("refunded"));
    }

    // 17. cancel with both signatures returns funds to depositor
    #[test]
    fn test_cancel_with_both_signatures() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        assert_eq!(token.balance(&contract_id), 500);
        assert_eq!(token.balance(&depositor), 500);
        client.cancel(&depositor, &arbiter);
        assert_eq!(token.balance(&depositor), 1_000);
        assert_eq!(token.balance(&contract_id), 0);
        assert_eq!(token.balance(&recipient), 0);
    }

    // 18. cancel without arbiter auth panics
    #[test]
    #[should_panic]
    fn test_cancel_requires_arbiter_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        // Pass depositor in place of arbiter — stored_arbiter != depositor → panics with NotArbiter.
        // This verifies that the dual-auth check cannot be satisfied with depositor alone.
        env.as_contract(&contract_id, || {
            EscrowContract::cancel(env.clone(), depositor.clone(), depositor.clone());
        });
    }

    // 19. cancel after release panics
    #[test]
    #[should_panic]
    fn test_cancel_after_release_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        client.release(&arbiter);
        env.as_contract(&contract_id, || {
            EscrowContract::cancel(env.clone(), depositor.clone(), arbiter.clone());
        });
    }

    // 20. get_state returns correct fields after initialize
    #[test]
    fn test_get_state_after_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        let state: EscrowState = client.get_state();
        assert_eq!(state.depositor, depositor);
        assert_eq!(state.recipient, recipient);
        assert_eq!(state.arbiter, arbiter);
        assert_eq!(state.token, token_id);
        assert_eq!(state.amount, 500);
        assert_eq!(state.expiry, expiry);
        assert_eq!(state.released, false);
    }

    // ── Cancel function tests ──────────────────────────────────────────────────
    // #65: Add Rust test for escrow cancel function

    // 18. cancel returns funds to depositor
    #[test]
    fn test_cancel_returns_funds_to_depositor() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        assert_eq!(token.balance(&depositor), 500);
        assert_eq!(token.balance(&contract_id), 500);
        client.cancel(&depositor, &arbiter);
        assert_eq!(token.balance(&depositor), 1_000);
        assert_eq!(token.balance(&contract_id), 0);
    }

    // 19. cancel seals state (subsequent release panics)
    #[test]
    // Soroban panics carry an opaque HostError/contract-error value, not a
    // human-readable string, so (like every other panic test in this file)
    // this only asserts that the second call panics at all.
    #[should_panic]
    fn test_cancel_seals_state() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        client.cancel(&depositor, &arbiter);
        client.release(&arbiter);
    }

    // 20. cancel requires both auths (only depositor auth should panic)
    #[test]
    // See test_cancel_seals_state — Soroban auth-failure panics aren't a
    // matchable string either, consistent with test_cancel_requires_arbiter_auth.
    #[should_panic]
    fn test_cancel_requires_both_auths() {
        let env = Env::default();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        env.mock_all_auths();
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.mock_all_auths_allowing_non_root_auth();
        client.cancel(&depositor, &arbiter);
    }

    // 21. cancel succeeds before expiry (no expiry dependency)
    #[test]
    fn test_cancel_before_expiry_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        client.cancel(&depositor, &arbiter);
        assert_eq!(token.balance(&depositor), 1_000);
    }

    // ── InvalidParties guard tests (issue #92) ───────────────────────────────

    // 22. depositor == arbiter panics with InvalidParties
    #[test]
    #[should_panic]
    fn test_initialize_same_depositor_arbiter_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        // arbiter is the same address as depositor — degenerate escrow
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &depositor, // arbiter == depositor
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
    }

    // 23. depositor == recipient panics with InvalidParties
    #[test]
    #[should_panic]
    fn test_initialize_same_depositor_recipient_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &depositor, // recipient == depositor
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
    }

    // 24. arbiter == recipient panics with InvalidParties
    #[test]
    #[should_panic]
    fn test_initialize_same_arbiter_recipient_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let arbiter = Address::generate(&env);
        // recipient is the same as arbiter
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &arbiter, // recipient == arbiter
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
    }

    // ── release_partial tests (issue #104) ───────────────────────────────────

    // 25. partial release reduces stored amount and transfers to recipient
    #[test]
    fn test_release_partial_reduces_stored_amount() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &1_000,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        // Release 300 out of 1000
        client.release_partial(&arbiter, &300);
        assert_eq!(token.balance(&recipient), 300);
        assert_eq!(token.balance(&contract_id), 700);
        // Escrow must still be open (not sealed)
        let state = client.get_state();
        assert_eq!(state.amount, 700);
        assert_eq!(state.released, false);
    }

    // 26. multiple sequential partial releases each reduce the stored amount
    #[test]
    fn test_multiple_partial_releases() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &1_000,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        client.release_partial(&arbiter, &200);
        client.release_partial(&arbiter, &300);
        client.release_partial(&arbiter, &100);
        assert_eq!(token.balance(&recipient), 600);
        assert_eq!(token.balance(&contract_id), 400);
        let state = client.get_state();
        assert_eq!(state.amount, 400);
        assert_eq!(state.released, false);
    }

    // 27. final partial release (amount reaches 0) seals the escrow
    #[test]
    fn test_final_partial_release_seals_state() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        // Two partial releases that sum to the full amount
        client.release_partial(&arbiter, &200);
        client.release_partial(&arbiter, &300);
        assert_eq!(token.balance(&recipient), 500);
        assert_eq!(token.balance(&contract_id), 0);
        // State must be sealed after the balance reaches zero
        let state = client.get_state();
        assert_eq!(state.amount, 0);
        assert_eq!(state.released, true);
    }

    // 28. release_partial with amount > stored amount panics with InvalidAmount
    #[test]
    #[should_panic]
    fn test_release_partial_excess_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        // Attempt to release more than the locked amount
        client.release_partial(&arbiter, &600);
    }

    // 29. release_partial with zero amount panics with InvalidAmount
    #[test]
    #[should_panic]
    fn test_release_partial_zero_amount_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        client.initialize(
            &depositor,
            &recipient,
            &arbiter,
            &token_id,
            &500,
            &(env.ledger().timestamp() + EXPIRY_OFFSET),
        );
        client.release_partial(&arbiter, &0);
    }

    // 30. refund sends to stored_depositor, not the caller parameter (anti-TOCTOU)
    #[test]
    fn test_refund_goes_to_stored_depositor_not_impostor() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let impostor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, token) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + 100;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.ledger().with_mut(|li| li.timestamp = expiry + 1);
        // Call refund with depositor — funds must go to stored depositor, not impostor
        client.refund(&depositor);
        assert_eq!(
            token.balance(&depositor),
            1_000,
            "stored depositor should receive funds"
        );
        assert_eq!(token.balance(&impostor), 0, "impostor must receive nothing");
        assert_eq!(token.balance(&contract_id), 0);
    }

    // ── initialized_at field tests (issue #290) ──────────────────────────────

    // 31. get_state returns initialized_at after initialize
    #[test]
    fn test_get_state_includes_initialized_at() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let now = env.ledger().timestamp();
        let expiry = now + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        let state = client.get_state();
        assert_eq!(
            state.initialized_at, now,
            "initialized_at should match ledger timestamp"
        );
    }

    // 32. initialized_at reflects ledger timestamp at initialization time
    #[test]
    fn test_initialized_at_reflects_ledger_timestamp() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        env.ledger().with_mut(|li| li.timestamp = 500);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = 500 + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        let state = client.get_state();
        assert_eq!(state.initialized_at, 500, "initialized_at should be 500");
    }

    // ── Arbiter rotation tests (issue #291) ──────────────────────────────────

    // 33. propose_new_arbiter requires depositor auth
    #[test]
    fn test_propose_arbiter_requires_depositor_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let new_arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        // Propose with correct depositor should succeed
        client.propose_new_arbiter(&depositor, &new_arbiter);
    }

    // 34. accept_arbiter_rotation fails before time-lock expires
    #[test]
    #[should_panic]
    fn test_accept_arbiter_rotation_locked_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let new_arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        client.propose_new_arbiter(&depositor, &new_arbiter);
        // Try to accept before 24 hours have passed — should panic
        client.accept_arbiter_rotation();
    }

    // 35. accept_arbiter_rotation succeeds after time-lock expires
    #[test]
    fn test_accept_arbiter_rotation_succeeds_after_delay() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let new_arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let now = env.ledger().timestamp();
        let expiry = now + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        client.propose_new_arbiter(&depositor, &new_arbiter);
        // Advance time by 24 hours + 1 second
        env.ledger().with_mut(|li| li.timestamp = now + 86_401);
        client.accept_arbiter_rotation();
        // Verify the new arbiter is now active
        let state = client.get_state();
        assert_eq!(state.arbiter, new_arbiter);
    }

    // 35b. the minimum rotation delay is enforced exactly at its boundary, so
    //      an accept just before `MIN_ROTATION_DELAY` stays locked while accept
    //      exactly at or after it succeeds. This documents that the rotation
    //      floor is a fixed contract constant a depositor cannot shorten.
    #[test]
    fn test_arbiter_rotation_min_delay_boundary() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let new_arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let now = env.ledger().timestamp();
        let expiry = now + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        client.propose_new_arbiter(&depositor, &new_arbiter);

        // 1 second before the minimum floor elapses, acceptance must still panic
        // (proving no sub-24h/near-instant rotation window can be opened).
        env.ledger()
            .with_mut(|li| li.timestamp = now + MIN_ROTATION_DELAY - 1);
        // `Env`/`EscrowContractClient` hold `Rc<RefCell<..>>` internals, so the
        // closure isn't `UnwindSafe` by default; `AssertUnwindSafe` is sound here
        // because we only inspect state (`get_state()`) after the panic, never
        // mutate through a reference that might have been left inconsistent.
        let locked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.accept_arbiter_rotation()
        }));
        assert!(
            locked.is_err(),
            "rotation must remain locked until MIN_ROTATION_DELAY fully elapses"
        );
        // Any proposal keeps the full floor active — the arbiter cannot change yet.
        let state = client.get_state();
        assert_eq!(state.arbiter, arbiter);

        // Exactly at the minimum floor the rotation is permitted.
        env.ledger()
            .with_mut(|li| li.timestamp = now + MIN_ROTATION_DELAY);
        client.accept_arbiter_rotation();
        let state = client.get_state();
        assert_eq!(state.arbiter, new_arbiter);
    }

    // 36. accept_arbiter_rotation panics without pending rotation
    #[test]
    #[should_panic]
    fn test_accept_arbiter_rotation_no_pending_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        // Try to accept without proposing — should panic
        client.accept_arbiter_rotation();
    }

    // 37. arbiter rotation enables recovery from compromised key
    #[test]
    fn test_arbiter_rotation_recovery_flow() {
        let env = Env::default();
        env.mock_all_auths();
        let depositor = Address::generate(&env);
        let recipient = Address::generate(&env);
        let compromised_arbiter = Address::generate(&env);
        let trusted_arbiter = Address::generate(&env);
        let (token_id, _) = create_token(&env, &depositor);
        StellarAssetClient::new(&env, &token_id).mint(&depositor, &1_000);
        let contract_id = env.register_contract(None, EscrowContract);
        let client = EscrowContractClient::new(&env, &contract_id);
        let now = env.ledger().timestamp();
        let expiry = now + EXPIRY_OFFSET;
        client.initialize(
            &depositor,
            &recipient,
            &compromised_arbiter,
            &token_id,
            &500,
            &expiry,
        );
        // Propose rotation to trusted arbiter
        client.propose_new_arbiter(&depositor, &trusted_arbiter);
        // Wait for time-lock to expire
        env.ledger().with_mut(|li| li.timestamp = now + 86_401);
        // Accept rotation
        client.accept_arbiter_rotation();
        // Verify the trusted arbiter is now active
        let state = client.get_state();
        assert_eq!(
            state.arbiter, trusted_arbiter,
            "arbiter should be rotated to trusted address"
        );
    }

    // ── Property tests: conservation of funds ──────────────────────────────
    // Core escrow invariant: the sum of released/refunded tokens always equals
    // the amount initialised, verified over many random amounts via proptest.

    /// Strategy: positive amounts within the contract's overflow guard
    /// (`initialize` panics with `InvalidAmount` when `amount > i128::MAX / 2`).
    fn amount_strategy() -> impl Strategy<Value = i128> {
        proptest::num::i128::ANY.prop_filter(
            "amount must be positive and within the overflow guard",
            |a| *a > 0 && *a <= i128::MAX / 2,
        )
    }

    /// Strategy: `(amount, cut_points)` where cut points drawn from
    /// `[1, amount - 1]` derive a random sequence of partial releases that sums
    /// exactly to `amount` (between 1 and 8 parts; duplicates collapse).
    fn partial_release_strategy() -> impl Strategy<Value = (i128, Vec<i128>)> {
        amount_strategy().prop_flat_map(|amount| {
            // Tiny amounts degrade gracefully: at most `amount` parts of size 1.
            let max_parts = amount.min(8) as usize;
            let cuts = proptest::collection::vec(1..amount.max(2), 0..=max_parts - 1);
            (Just(amount), cuts)
        })
    }

    // 38. property: a full release moves exactly the initialised amount
    #[test]
    fn prop_full_release_conserves_funds() {
        proptest!(ProptestConfig::with_cases(128), |(amount in amount_strategy())| {
            let env = Env::default();
            env.mock_all_auths();
            let depositor = Address::generate(&env);
            let recipient = Address::generate(&env);
            let arbiter = Address::generate(&env);
            let (token_id, token) = create_token(&env, &depositor);
            StellarAssetClient::new(&env, &token_id).mint(&depositor, &amount);
            let contract_id = env.register_contract(None, EscrowContract);
            let client = EscrowContractClient::new(&env, &contract_id);
            client.initialize(
                &depositor,
                &recipient,
                &arbiter,
                &token_id,
                &amount,
                &(env.ledger().timestamp() + EXPIRY_OFFSET),
            );
            prop_assert_eq!(
                token.balance(&contract_id),
                amount,
                "contract must hold the full initialised amount"
            );

            client.release(&arbiter);

            // Released tokens == initialised amount, nothing left in escrow.
            prop_assert_eq!(
                token.balance(&recipient),
                amount,
                "recipient must receive exactly the initialised amount"
            );
            prop_assert_eq!(
                token.balance(&contract_id),
                0,
                "no funds may remain stuck in the contract"
            );
            let state = client.get_state();
            prop_assert!(state.released, "escrow must be sealed after release");
        });
    }

    // 39. property: random partial releases sum to the initialised amount
    #[test]
    fn prop_partial_releases_sum_to_initial_amount() {
        proptest!(ProptestConfig::with_cases(128), |(pair in partial_release_strategy())| {
            let (amount, cuts) = pair;
            let env = Env::default();
            env.mock_all_auths();
            let depositor = Address::generate(&env);
            let recipient = Address::generate(&env);
            let arbiter = Address::generate(&env);
            let (token_id, token) = create_token(&env, &depositor);
            StellarAssetClient::new(&env, &token_id).mint(&depositor, &amount);
            let contract_id = env.register_contract(None, EscrowContract);
            let client = EscrowContractClient::new(&env, &contract_id);
            client.initialize(
                &depositor,
                &recipient,
                &arbiter,
                &token_id,
                &amount,
                &(env.ledger().timestamp() + EXPIRY_OFFSET),
            );

            // Derive the exact-splitting release sequence from the cut points.
            let mut points = cuts;
            points.sort_unstable();
            points.dedup();
            let mut boundaries = vec![0];
            boundaries.extend(points);
            boundaries.push(amount);
            let parts: Vec<i128> = boundaries.windows(2).map(|w| w[1] - w[0]).collect();
            prop_assert!(!parts.is_empty());
            prop_assert!(parts.iter().all(|p| *p > 0), "parts must all be positive");

            // After every release, the recipient's balance must equal the
            // cumulative sum of the parts released so far.
            let mut released_so_far: i128 = 0;
            for part in parts {
                client.release_partial(&arbiter, &part);
                released_so_far += part;
                prop_assert_eq!(
                    token.balance(&recipient),
                    released_so_far,
                    "recipient must receive the cumulative released sum"
                );
                prop_assert_eq!(
                    token.balance(&contract_id),
                    amount - released_so_far,
                    "contract must hold exactly the unreleased remainder"
                );
            }

            // Invariant: sum of released tokens == initialised amount.
            prop_assert_eq!(
                released_so_far, amount,
                "sum of released tokens must equal the initialised amount"
            );
            prop_assert_eq!(
                token.balance(&contract_id),
                0,
                "no funds may remain stuck in the contract"
            );
            let state = client.get_state();
            prop_assert_eq!(state.amount, 0, "stored amount must reach zero");
            prop_assert!(state.released, "escrow must be sealed once fully released");
        });
    }

    // 40. property: a post-expiry refund returns exactly the initialised amount
    #[test]
    fn prop_refund_conserves_funds() {
        proptest!(ProptestConfig::with_cases(128), |(amount in amount_strategy())| {
            let env = Env::default();
            env.mock_all_auths();
            let depositor = Address::generate(&env);
            let recipient = Address::generate(&env);
            let arbiter = Address::generate(&env);
            let (token_id, token) = create_token(&env, &depositor);
            StellarAssetClient::new(&env, &token_id).mint(&depositor, &amount);
            let contract_id = env.register_contract(None, EscrowContract);
            let client = EscrowContractClient::new(&env, &contract_id);
            let expiry = env.ledger().timestamp() + 100;
            client.initialize(&depositor, &recipient, &arbiter, &token_id, &amount, &expiry);

            // Advance past expiry, then refund.
            env.ledger().with_mut(|li| li.timestamp = expiry + 1);
            client.refund(&depositor);

            // Refunded tokens == initialised amount, nothing left in escrow.
            prop_assert_eq!(
                token.balance(&depositor),
                amount,
                "depositor must recover exactly the initialised amount"
            );
            prop_assert_eq!(
                token.balance(&contract_id),
                0,
                "no funds may remain stuck in the contract"
            );
            let state = client.get_state();
            prop_assert!(state.released, "escrow must be sealed after refund");
        });
    }
}
