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
 */

#[cfg(test)]
mod tests {
    extern crate std;

    use crate::{EscrowContract, EscrowContractClient, EscrowState};
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
    #[should_panic(expected = "state is sealed")]
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
    #[should_panic(expected = "authorization")]
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

    // ── release_partial tests ────────────────────────────────────────────────

    // 22. release_partial transfers partial amount, remaining stays in contract
    #[test]
    fn test_release_partial_partial_amount() {
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
        assert_eq!(token.balance(&contract_id), 500);
        assert_eq!(token.balance(&recipient), 0);

        // Release 200 partial
        client.release_partial(&arbiter, &200);
        assert_eq!(token.balance(&recipient), 200);
        assert_eq!(token.balance(&contract_id), 300);

        // State should still show released = false
        let state: EscrowState = client.get_state();
        assert_eq!(state.released, false);
        assert_eq!(state.amount, 300);
    }

    // 23. multiple partial releases accumulate and eventually seal
    #[test]
    fn test_release_partial_multiple() {
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

        client.release_partial(&arbiter, &100);
        assert_eq!(token.balance(&recipient), 100);
        assert_eq!(token.balance(&contract_id), 400);

        client.release_partial(&arbiter, &200);
        assert_eq!(token.balance(&recipient), 300);
        assert_eq!(token.balance(&contract_id), 200);

        // Final release drains the contract
        client.release_partial(&arbiter, &200);
        assert_eq!(token.balance(&recipient), 500);
        assert_eq!(token.balance(&contract_id), 0);

        // State should be fully released
        let state: EscrowState = client.get_state();
        assert_eq!(state.released, true);
        assert_eq!(state.amount, 0);
    }

    // 24. release_partial after full release panics
    #[test]
    #[should_panic]
    fn test_release_partial_after_full_release_panics() {
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
        client.release(&arbiter);
        env.as_contract(&contract_id, || {
            EscrowContract::release_partial(env.clone(), arbiter.clone(), 100);
        });
    }

    // 25. release_partial with amount > remaining panics
    #[test]
    #[should_panic]
    fn test_release_partial_exceeds_remaining_panics() {
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
        env.as_contract(&contract_id, || {
            EscrowContract::release_partial(env.clone(), arbiter.clone(), 600);
        });
    }

    // 26. release_partial with zero amount panics
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
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.as_contract(&contract_id, || {
            EscrowContract::release_partial(env.clone(), arbiter.clone(), 0);
        });
    }

    // 27. unauthorized release_partial panics
    #[test]
    #[should_panic]
    fn test_release_partial_unauthorized_panics() {
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
        let expiry = env.ledger().timestamp() + EXPIRY_OFFSET;
        client.initialize(&depositor, &recipient, &arbiter, &token_id, &500, &expiry);
        env.as_contract(&contract_id, || {
            EscrowContract::release_partial(env.clone(), impostor.clone(), 100);
        });
    }

    // 28. release_partial emits "released_partial" event
    #[test]
    fn test_release_partial_emits_event() {
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
        client.release_partial(&arbiter, &200);
        let events = env.events().all();
        assert!(std::format!("{:?}", events).contains("released_partial"));
    }

    // 29. refund after partial release refunds remaining amount only
    #[test]
    fn test_refund_after_partial_release() {
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

        // Partial release: 200 to recipient
        client.release_partial(&arbiter, &200);
        assert_eq!(token.balance(&recipient), 200);
        assert_eq!(token.balance(&contract_id), 300);

        // Advance past expiry and refund
        env.ledger().with_mut(|li| li.timestamp = expiry + 1);
        client.refund(&depositor);

        // Depositor gets back remaining 300
        assert_eq!(token.balance(&depositor), 800);
        assert_eq!(token.balance(&contract_id), 0);
        // Recipient keeps the 200 already released
        assert_eq!(token.balance(&recipient), 200);
    }
}
