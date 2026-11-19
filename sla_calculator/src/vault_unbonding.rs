// Vault drain protection timelock: 7-day unbonding delay on collateral
// withdrawal requests. Complements reward_cap.rs.
use soroban_sdk::{contracttype, symbol_short, Address, Env, Map, Symbol};

const SEVEN_DAYS_SECS: u64 = 7 * 24 * 60 * 60;
/// #1038 — per-tranche unbonding requests keyed by (operator, tranche).
const UNBONDING_KEY: Symbol = symbol_short!("UNBND");

#[contracttype]
pub struct UnbondingRequest {
    pub operator: Address,
    pub amount: i128,
    pub requested_at: u64,
    pub has_pending_penalty: bool,
}

/// Starts the 7-day unbonding window for a withdrawal request.
pub fn start_unbonding(env: &Env, operator: &Address, amount: i128) -> UnbondingRequest {
    operator.require_auth();
    UnbondingRequest {
        operator: operator.clone(),
        amount,
        requested_at: env.ledger().timestamp(),
        has_pending_penalty: false,
    }
}

/// #1038 — request (or increase) unbonding for a specific tranche.
///
/// A second request for an already-locked tranche increases the pending
/// amount but never resets the original `requested_at`, so the unlock ledger
/// stays stable. Different tranches keep independent unlock ledgers.
pub fn request_unbonding(
    env: &Env,
    operator: &Address,
    tranche: &Symbol,
    amount: i128,
) -> UnbondingRequest {
    operator.require_auth();
    let mut requests: Map<(Address, Symbol), UnbondingRequest> = env
        .storage()
        .persistent()
        .get(&UNBONDING_KEY)
        .unwrap_or(Map::new(env));
    let key = (operator.clone(), tranche.clone());

    let request = match requests.get(key.clone()) {
        Some(mut existing) => {
            existing.amount = existing.amount.saturating_add(amount);
            existing
        }
        None => start_unbonding(env, operator, amount),
    };
    requests.set(key, request.clone());
    env.storage().persistent().set(&UNBONDING_KEY, &requests);

    // The event identifies the tranche and the new amount independently of
    // the original unlock ledger.
    env.events().publish(
        (crate::event_schema::EVENT_UNBONDING_UPDATED, tranche.clone()),
        (operator.clone(), amount),
    );
    request
}

/// Look up the persisted request for a tranche.
pub fn unbonding_for(env: &Env, operator: &Address, tranche: &Symbol) -> Option<UnbondingRequest> {
    let requests: Map<(Address, Symbol), UnbondingRequest> = env
        .storage()
        .persistent()
        .get(&UNBONDING_KEY)
        .unwrap_or(Map::new(env));
    requests.get((operator.clone(), tranche.clone()))
}

/// Withdrawal is executable once 7 days have elapsed and no pending
/// penalty claims lock the collateral.
pub fn is_unbonding_complete(env: &Env, request: &UnbondingRequest) -> bool {
    !request.has_pending_penalty
        && env.ledger().timestamp() >= request.requested_at + SEVEN_DAYS_SECS
}

/// Amount still locked by an unbonding request: the full amount until the
/// request is executable, and `0` once it can be withdrawn.
pub fn pending_unbonding_amount(env: &Env, request: &UnbondingRequest) -> i128 {
    if is_unbonding_complete(env, request) {
        0
    } else {
        request.amount
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SLACalculatorContract;
    use soroban_sdk::testutils::{Address as _, Ledger as _};

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let id = env.register_contract(None, SLACalculatorContract);
        let operator = Address::generate(&env);
        (env, id, operator)
    }

    #[test]
    fn test_not_complete_one_second_before_seven_days() {
        let (env, id, op) = setup();
        let req = env.as_contract(&id, || start_unbonding(&env, &op, 500));
        env.ledger().with_mut(|l| l.timestamp = 1_000 + SEVEN_DAYS_SECS - 1);
        assert!(!is_unbonding_complete(&env, &req));
    }

    #[test]
    fn test_complete_exactly_at_seven_days() {
        let (env, id, op) = setup();
        let req = env.as_contract(&id, || start_unbonding(&env, &op, 500));
        env.ledger().with_mut(|l| l.timestamp = 1_000 + SEVEN_DAYS_SECS);
        assert!(is_unbonding_complete(&env, &req));
    }

    #[test]
    fn test_pending_penalty_blocks_completion_after_the_delay() {
        let (env, id, op) = setup();
        let mut req = env.as_contract(&id, || start_unbonding(&env, &op, 500));
        req.has_pending_penalty = true;
        env.ledger().with_mut(|l| l.timestamp = 1_000 + SEVEN_DAYS_SECS * 2);
        assert!(!is_unbonding_complete(&env, &req));
    }

    #[test]
    fn test_pending_amount_view_drops_to_zero_once_executable() {
        let (env, id, op) = setup();
        let req = env.as_contract(&id, || start_unbonding(&env, &op, 500));
        assert_eq!(pending_unbonding_amount(&env, &req), 500);
        env.ledger().with_mut(|l| l.timestamp = 1_000 + SEVEN_DAYS_SECS);
        assert_eq!(pending_unbonding_amount(&env, &req), 0);
    }
}

#[cfg(test)]
mod tranche_unlock_tests {
    use super::*;
    use soroban_sdk::testutils::Events as _;

    #[test]
    fn a_second_request_keeps_the_first_unlock_ledger() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let id = env.register_contract(None, crate::SLACalculatorContract);
        let operator = Address::generate(&env);
        let tranche = Symbol::new(&env, "tranche_a");

        env.as_contract(&id, || {
            let first = request_unbonding(&env, &operator, &tranche, 500);
            env.ledger().with_mut(|l| l.timestamp = 5_000);
            let second = request_unbonding(&env, &operator, &tranche, 250);

            assert_eq!(first.requested_at, 1_000);
            assert_eq!(second.requested_at, 1_000);
            assert_eq!(second.amount, 750);
            assert_eq!(
                unbonding_for(&env, &operator, &tranche).unwrap().requested_at,
                1_000
            );
        });
    }

    #[test]
    fn separate_tranches_have_independent_unlock_ledgers_and_events() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|l| l.timestamp = 1_000);
        let id = env.register_contract(None, crate::SLACalculatorContract);
        let operator = Address::generate(&env);
        let a = Symbol::new(&env, "tranche_a");
        let b = Symbol::new(&env, "tranche_b");

        env.as_contract(&id, || {
            request_unbonding(&env, &operator, &a, 500);
            env.ledger().with_mut(|l| l.timestamp = 9_000);
            request_unbonding(&env, &operator, &b, 100);

            assert_eq!(unbonding_for(&env, &operator, &a).unwrap().requested_at, 1_000);
            assert_eq!(unbonding_for(&env, &operator, &b).unwrap().requested_at, 9_000);
            assert_eq!(env.events().all().len(), 2);
        });
    }
}
