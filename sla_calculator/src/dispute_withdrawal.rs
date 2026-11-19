// Dispute withdrawal mechanism before voting begins. Complements
// dispute.rs.
use soroban_sdk::{contracterror, symbol_short, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum WithdrawalError {
    WindowExpired = 1,
    VotesAlreadyCast = 2,
    AlreadyFinalized = 3,
    DisputesPaused = 4,
    /// #1036 — a non-positive partial withdrawal amount.
    InvalidWithdrawalAmount = 5,
}

/// #1036 — accounting plan for a partial withdrawal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PartialWithdrawal {
    /// Bond still locked before this withdrawal.
    pub remaining_before: i128,
    /// Amount of bond released by this withdrawal (never above the remainder).
    pub released: i128,
    /// Refund paid to the submitter.
    pub refund: i128,
    /// Bond left locked after this withdrawal.
    pub remaining_after: i128,
}

/// Plan a partial withdrawal so that rounding or stale reads can never let
/// cumulative withdrawals exceed the original bond.
pub fn plan_partial_withdrawal(
    original_bond: i128,
    already_withdrawn: i128,
    requested: i128,
) -> Result<PartialWithdrawal, WithdrawalError> {
    if requested <= 0 {
        return Err(WithdrawalError::InvalidWithdrawalAmount);
    }
    if already_withdrawn >= original_bond || original_bond <= 0 {
        return Err(WithdrawalError::InvalidWithdrawalAmount);
    }
    let remaining_before = original_bond - already_withdrawn;
    let released = requested.min(remaining_before);
    let refund = released * 95 / 100;
    Ok(PartialWithdrawal {
        remaining_before,
        released,
        refund,
        remaining_after: remaining_before - released,
    })
}

/// Execute a checked partial withdrawal within the remaining bond.
#[allow(clippy::too_many_arguments)]
pub fn withdraw_partial_checked(
    env: &Env,
    submitter: &Address,
    dispute_id: u64,
    filed_at: u64,
    votes_cast: u32,
    original_bond: i128,
    already_withdrawn: i128,
    requested: i128,
    finalized: bool,
    disputes_paused: bool,
) -> Result<PartialWithdrawal, WithdrawalError> {
    let plan = plan_partial_withdrawal(original_bond, already_withdrawn, requested)?;
    withdraw_dispute_checked(
        env,
        submitter,
        dispute_id,
        filed_at,
        votes_cast,
        plan.released,
        finalized,
        disputes_paused,
    )?;
    Ok(plan)
}

const TWO_HOURS_SECS: u64 = 2 * 60 * 60;
const WITHDRAWN_EVENT: Symbol = symbol_short!("dwithdrw");

/// Submitter withdraws a dispute within 2 hours, refunding 95% of the
/// bond, provided no arbitrator votes have been recorded yet.
pub fn withdraw_dispute(
    env: &Env,
    submitter: &Address,
    dispute_id: u64,
    filed_at: u64,
    votes_cast: u32,
    bond_amount: i128,
) -> Result<i128, WithdrawalError> {
    submitter.require_auth();
    if env.ledger().timestamp() > filed_at + TWO_HOURS_SECS {
        return Err(WithdrawalError::WindowExpired);
    }
    if votes_cast > 0 {
        return Err(WithdrawalError::VotesAlreadyCast);
    }
    let refund = bond_amount * 95 / 100;
    env.events().publish((WITHDRAWN_EVENT,), dispute_id);
    Ok(refund)
}

/// Same as `withdraw_dispute`, but rejects withdrawals once the dispute is
/// finalized or while disputes are paused.
#[allow(clippy::too_many_arguments)]
pub fn withdraw_dispute_checked(
    env: &Env,
    submitter: &Address,
    dispute_id: u64,
    filed_at: u64,
    votes_cast: u32,
    bond_amount: i128,
    finalized: bool,
    disputes_paused: bool,
) -> Result<i128, WithdrawalError> {
    if disputes_paused {
        return Err(WithdrawalError::DisputesPaused);
    }
    if finalized {
        return Err(WithdrawalError::AlreadyFinalized);
    }
    withdraw_dispute(env, submitter, dispute_id, filed_at, votes_cast, bond_amount)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SLACalculatorContract;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn withdrawal_before_finalization_refunds_the_bond() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = env.register_contract(None, SLACalculatorContract);
        env.as_contract(&contract, || {
            let submitter = Address::generate(&env);
            let result =
                withdraw_dispute_checked(&env, &submitter, 1, 0, 0, 1_000, false, false);
            assert_eq!(result, Ok(950));
        });
    }

    #[test]
    fn withdrawal_after_finalization_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = env.register_contract(None, SLACalculatorContract);
        env.as_contract(&contract, || {
            let submitter = Address::generate(&env);
            let result = withdraw_dispute_checked(&env, &submitter, 1, 0, 0, 1_000, true, false);
            assert_eq!(result, Err(WithdrawalError::AlreadyFinalized));
        });
    }

    #[test]
    fn withdrawal_while_paused_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract = env.register_contract(None, SLACalculatorContract);
        env.as_contract(&contract, || {
            let submitter = Address::generate(&env);
            let result = withdraw_dispute_checked(&env, &submitter, 1, 0, 0, 1_000, false, true);
            assert_eq!(result, Err(WithdrawalError::DisputesPaused));
        });
    }
}

#[cfg(test)]
mod partial_withdrawal_tests {
    use super::*;

    #[test]
    fn repeated_partial_withdrawals_stay_within_the_original_bond() {
        let mut withdrawn = 0i128;
        let original = 1_000i128;
        for requested in [300, 300, 300, 300] {
            let plan = plan_partial_withdrawal(original, withdrawn, requested).unwrap();
            withdrawn += plan.released;
        }
        assert_eq!(withdrawn, 1_000);
        assert_eq!(
            plan_partial_withdrawal(original, withdrawn, 1),
            Err(WithdrawalError::InvalidWithdrawalAmount)
        );
    }

    #[test]
    fn a_request_above_the_remainder_is_capped_not_overflowing() {
        let plan = plan_partial_withdrawal(1_000, 900, 500).unwrap();
        assert_eq!(plan.released, 100);
        assert_eq!(plan.remaining_after, 0);
        assert_eq!(plan.refund, 95);
    }

    #[test]
    fn a_non_positive_request_is_rejected() {
        assert_eq!(
            plan_partial_withdrawal(1_000, 0, 0),
            Err(WithdrawalError::InvalidWithdrawalAmount)
        );
    }
}
