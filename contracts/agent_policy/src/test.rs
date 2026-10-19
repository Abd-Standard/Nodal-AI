/*!
 * contracts/agent_policy/src/test.rs
 *
 * Tests for the agent spending-policy account prototype (issue #813).
 * `__check_auth` is driven directly through
 * `Env::try_invoke_contract_check_auth` with real ed25519 signatures, so the
 * exact code path the network runs on every authorised transaction is
 * exercised — no live network required.
 *
 * Coverage:
 *   Limit     : within limit, single over-limit spend, cumulative over-limit
 *   Window    : spend allowed again once the window rolls over
 *   Deny list : other tokens, calls to the account itself
 *   Auth      : wrong signature, owner-only policy changes
 */

#[cfg(test)]
mod tests {
    extern crate std;

    use crate::{AgentPolicyAccount, AgentPolicyAccountClient, PolicyError};
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{
        auth::{Context, ContractContext},
        symbol_short,
        testutils::{Address as _, Ledger},
        vec, Address, BytesN, Env, IntoVal, Symbol,
    };

    const LIMIT: i128 = 100;
    const WINDOW: u64 = 86_400;

    struct Setup {
        env: Env,
        account: Address,
        owner: Address,
        token: Address,
        signer: SigningKey,
    }

    fn setup() -> Setup {
        let env = Env::default();
        env.mock_all_auths();
        let signer = SigningKey::from_bytes(&[7u8; 32]);
        let agent_key = BytesN::from_array(&env, &signer.verifying_key().to_bytes());
        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let account = env.register_contract(None, AgentPolicyAccount);
        AgentPolicyAccountClient::new(&env, &account).init(
            &agent_key, &owner, &token, &LIMIT, &WINDOW,
        );
        Setup {
            env,
            account,
            owner,
            token,
            signer,
        }
    }

    fn transfer_ctx(s: &Setup, token: &Address, amount: i128) -> Context {
        Context::Contract(ContractContext {
            contract: token.clone(),
            fn_name: symbol_short!("transfer"),
            args: (s.account.clone(), Address::generate(&s.env), amount).into_val(&s.env),
        })
    }

    /// Run `__check_auth` signed by `signer`. `Err(Some(e))` is a policy
    /// rejection, `Err(None)` a host-level failure (e.g. bad signature).
    fn check_signed(
        s: &Setup,
        signer: &SigningKey,
        contexts: soroban_sdk::Vec<Context>,
    ) -> Result<(), Option<PolicyError>> {
        let payload = BytesN::from_array(&s.env, &[42u8; 32]);
        let signature = BytesN::from_array(&s.env, &signer.sign(&payload.to_array()).to_bytes());
        match s.env.try_invoke_contract_check_auth::<PolicyError>(
            &s.account,
            &payload,
            signature.into_val(&s.env),
            &contexts,
        ) {
            Ok(()) => Ok(()),
            Err(Ok(e)) => Err(Some(e)),
            Err(Err(_)) => Err(None),
        }
    }

    fn check(s: &Setup, contexts: soroban_sdk::Vec<Context>) -> Result<(), Option<PolicyError>> {
        check_signed(s, &s.signer, contexts)
    }

    fn spent(s: &Setup) -> i128 {
        AgentPolicyAccountClient::new(&s.env, &s.account)
            .get_policy()
            .spent
    }

    // 1. a spend within the limit is authorised and recorded
    #[test]
    fn test_spend_within_limit_is_allowed() {
        let s = setup();
        let ctx = transfer_ctx(&s, &s.token, 60);
        assert_eq!(check(&s, vec![&s.env, ctx]), Ok(()));
        assert_eq!(spent(&s), 60);
    }

    // 2. a single spend above the limit is rejected on-chain, even with the key
    #[test]
    fn test_single_spend_over_limit_is_rejected() {
        let s = setup();
        let ctx = transfer_ctx(&s, &s.token, LIMIT + 1);
        assert_eq!(
            check(&s, vec![&s.env, ctx]),
            Err(Some(PolicyError::OverLimit))
        );
        assert_eq!(spent(&s), 0);
    }

    // 3. cumulative spends inside one window cannot exceed the limit
    #[test]
    fn test_cumulative_spend_over_limit_is_rejected() {
        let s = setup();
        let first = transfer_ctx(&s, &s.token, 60);
        assert_eq!(check(&s, vec![&s.env, first]), Ok(()));
        let second = transfer_ctx(&s, &s.token, 50);
        assert_eq!(
            check(&s, vec![&s.env, second]),
            Err(Some(PolicyError::OverLimit))
        );
        assert_eq!(spent(&s), 60);
    }

    // 4. several transfers batched into one tx are summed
    #[test]
    fn test_batched_spends_are_summed() {
        let s = setup();
        let a = transfer_ctx(&s, &s.token, 60);
        let b = transfer_ctx(&s, &s.token, 41);
        assert_eq!(
            check(&s, vec![&s.env, a, b]),
            Err(Some(PolicyError::OverLimit))
        );
    }

    // 5. the allowance resets once the window has elapsed
    #[test]
    fn test_window_rollover_resets_allowance() {
        let s = setup();
        let first = transfer_ctx(&s, &s.token, LIMIT);
        assert_eq!(check(&s, vec![&s.env, first]), Ok(()));
        let start = s.env.ledger().timestamp();
        s.env
            .ledger()
            .with_mut(|li| li.timestamp = start + WINDOW);
        let second = transfer_ctx(&s, &s.token, LIMIT);
        assert_eq!(check(&s, vec![&s.env, second]), Ok(()));
        assert_eq!(spent(&s), LIMIT);
    }

    // 6. value movement of an asset outside the policy is denied
    #[test]
    fn test_other_token_is_forbidden() {
        let s = setup();
        let other = Address::generate(&s.env);
        let ctx = transfer_ctx(&s, &other, 1);
        assert_eq!(
            check(&s, vec![&s.env, ctx]),
            Err(Some(PolicyError::ForbiddenContext))
        );
    }

    // 7. the agent key cannot call the account itself (e.g. to reconfigure it)
    #[test]
    fn test_self_call_is_forbidden() {
        let s = setup();
        let ctx = Context::Contract(ContractContext {
            contract: s.account.clone(),
            fn_name: Symbol::new(&s.env, "set_policy"),
            args: (i128::MAX, WINDOW).into_val(&s.env),
        });
        assert_eq!(
            check(&s, vec![&s.env, ctx]),
            Err(Some(PolicyError::ForbiddenContext))
        );
    }

    // 8. calls that move no value pass without consuming allowance
    #[test]
    fn test_non_value_call_is_allowed() {
        let s = setup();
        let ctx = Context::Contract(ContractContext {
            contract: Address::generate(&s.env),
            fn_name: Symbol::new(&s.env, "get_state"),
            args: soroban_sdk::Vec::new(&s.env),
        });
        assert_eq!(check(&s, vec![&s.env, ctx]), Ok(()));
        assert_eq!(spent(&s), 0);
    }

    // 9. a signature from any key other than the agent key is rejected
    #[test]
    fn test_wrong_signer_is_rejected() {
        let s = setup();
        let attacker = SigningKey::from_bytes(&[9u8; 32]);
        let ctx = transfer_ctx(&s, &s.token, 1);
        assert!(check_signed(&s, &attacker, vec![&s.env, ctx]).is_err());
    }

    // 10. only the owner can change the policy
    #[test]
    fn test_set_policy_requires_owner_auth() {
        let s = setup();
        let client = AgentPolicyAccountClient::new(&s.env, &s.account);
        client.set_policy(&500, &WINDOW);
        let auths = s.env.auths();
        assert_eq!(auths.len(), 1);
        assert_eq!(auths[0].0, s.owner);
        assert_eq!(client.get_policy().limit, 500);
    }

    // 11. a non-positive limit is rejected at init
    #[test]
    #[should_panic]
    fn test_init_with_zero_limit_panics() {
        let env = Env::default();
        env.mock_all_auths();
        let agent_key = BytesN::from_array(&env, &[1u8; 32]);
        let owner = Address::generate(&env);
        let token = Address::generate(&env);
        let account = env.register_contract(None, AgentPolicyAccount);
        AgentPolicyAccountClient::new(&env, &account).init(&agent_key, &owner, &token, &0, &WINDOW);
    }
}
