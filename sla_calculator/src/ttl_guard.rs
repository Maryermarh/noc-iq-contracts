use soroban_sdk::{Env, Symbol};

/// Minimum instance-storage TTL (in ledgers) the contract should maintain.
pub const MIN_INSTANCE_TTL_LEDGERS: u32 = 100_000;
/// Amount to bump the TTL by once it drops below the threshold.
pub const INSTANCE_TTL_BUMP_LEDGERS: u32 = 200_000;

/// Ensures instance storage TTL never drops below `MIN_INSTANCE_TTL_LEDGERS`.
/// Intended to be called at the top of state-mutating entry points.
pub fn ensure_instance_ttl(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(MIN_INSTANCE_TTL_LEDGERS, INSTANCE_TTL_BUMP_LEDGERS);
}

/// What a call to [`renew_persistent_ttl`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenewalOutcome {
    /// The renewal was requested. The entry is extended only if its current TTL is shorter than
    /// the one requested; a longer existing TTL is left exactly as it is.
    Requested,
    /// The requested expiry ledger is not in the future, so nothing was changed.
    PastExpiry,
    /// There is no live entry under the key. Renewal never creates or resurrects an entry.
    NotLive,
}

/// Renews a persistent entry so that it lives until at least `requested_expiry_ledger`, and never
/// shortens it.
///
/// `extend_ttl(key, threshold, extend_to)` only acts when the current TTL is below `threshold`.
/// Using the requested remaining lifetime as both values means the entry is extended exactly when
/// it would otherwise expire sooner than requested, so a caller that supplies an earlier expiry
/// than the entry already has leaves the longer TTL untouched. The request is clamped to the
/// network maximum so an oversized expiry cannot trap.
pub fn renew_persistent_ttl(
    env: &Env,
    key: &Symbol,
    requested_expiry_ledger: u32,
) -> RenewalOutcome {
    if !env.storage().persistent().has(key) {
        return RenewalOutcome::NotLive;
    }
    let remaining = requested_expiry_ledger.saturating_sub(env.ledger().sequence());
    if remaining == 0 {
        return RenewalOutcome::PastExpiry;
    }
    let target = remaining.min(env.storage().max_ttl());
    env.storage().persistent().extend_ttl(key, target, target);
    RenewalOutcome::Requested
}

/// #1029 — whether a read path may refresh a record's lifetime.
///
/// A record with no remaining lifetime is expired and must stay absent; a
/// live record follows the documented retention threshold policy.
pub fn should_refresh_after_read(remaining_ledgers: u32, threshold: u32) -> bool {
    remaining_ledgers > 0 && remaining_ledgers < threshold
}

#[cfg(test)]
mod read_refresh_tests {
    use super::*;

    #[test]
    fn expired_records_are_never_refreshed_by_a_read() {
        assert!(!should_refresh_after_read(0, MIN_INSTANCE_TTL_LEDGERS));
    }

    #[test]
    fn live_records_are_refreshed_only_below_the_threshold() {
        assert!(should_refresh_after_read(
            MIN_INSTANCE_TTL_LEDGERS - 1,
            MIN_INSTANCE_TTL_LEDGERS
        ));
        assert!(!should_refresh_after_read(
            MIN_INSTANCE_TTL_LEDGERS,
            MIN_INSTANCE_TTL_LEDGERS
        ));
    }
}

#[cfg(test)]
mod renewal_tests {
    use super::*;
    use crate::SLACalculatorContract;
    use soroban_sdk::testutils::{storage::Persistent as _, Ledger as _};

    fn seeded(env: &Env, name: &str) -> (soroban_sdk::Address, Symbol) {
        let id = env.register_contract(None, SLACalculatorContract);
        let key = Symbol::new(env, name);
        env.as_contract(&id, || env.storage().persistent().set(&key, &1u32));
        (id, key)
    }

    #[test]
    fn an_earlier_expiry_preserves_the_longer_current_ttl() {
        let env = Env::default();
        let (id, key) = seeded(&env, "K1");
        env.as_contract(&id, || {
            env.storage().persistent().extend_ttl(&key, 900_000, 900_000);
            let before = env.storage().persistent().get_ttl(&key);

            let earlier = env.ledger().sequence() + 10_000;
            assert_eq!(renew_persistent_ttl(&env, &key, earlier), RenewalOutcome::Requested);

            assert_eq!(env.storage().persistent().get_ttl(&key), before);
        });
    }

    #[test]
    fn a_later_expiry_extends_a_live_entry() {
        let env = Env::default();
        let (id, key) = seeded(&env, "K2");
        env.as_contract(&id, || {
            let before = env.storage().persistent().get_ttl(&key);
            let later = env.ledger().sequence() + 700_000;
            assert!(later - env.ledger().sequence() > before);

            assert_eq!(renew_persistent_ttl(&env, &key, later), RenewalOutcome::Requested);

            assert!(env.storage().persistent().get_ttl(&key) >= 700_000);
        });
    }

    #[test]
    fn repeated_renewals_never_decrease_the_ttl() {
        let env = Env::default();
        let (id, key) = seeded(&env, "K3");
        env.as_contract(&id, || {
            let now = env.ledger().sequence();
            let mut last = env.storage().persistent().get_ttl(&key);
            for expiry in [now + 900_000, now + 800_000, now + 50_000, now + 950_000, now + 1] {
                renew_persistent_ttl(&env, &key, expiry);
                let ttl = env.storage().persistent().get_ttl(&key);
                assert!(ttl >= last, "ttl shrank from {last} to {ttl} for expiry {expiry}");
                last = ttl;
            }
        });
    }

    #[test]
    fn an_expiry_that_is_not_in_the_future_changes_nothing() {
        let env = Env::default();
        let (id, key) = seeded(&env, "K4");
        // Keep the entry alive past the ledger we are about to move to.
        env.as_contract(&id, || env.storage().persistent().extend_ttl(&key, 100_000, 100_000));
        env.ledger().set_sequence_number(5_000);
        env.as_contract(&id, || {
            let before = env.storage().persistent().get_ttl(&key);

            assert_eq!(renew_persistent_ttl(&env, &key, 5_000), RenewalOutcome::PastExpiry);
            assert_eq!(renew_persistent_ttl(&env, &key, 10), RenewalOutcome::PastExpiry);

            assert_eq!(env.storage().persistent().get_ttl(&key), before);
        });
    }

    #[test]
    fn a_missing_entry_is_not_created_or_resurrected() {
        let env = Env::default();
        let id = env.register_contract(None, SLACalculatorContract);
        env.as_contract(&id, || {
            let absent = Symbol::new(&env, "GONE");

            let later = env.ledger().sequence() + 100_000;
            assert_eq!(renew_persistent_ttl(&env, &absent, later), RenewalOutcome::NotLive);

            assert!(!env.storage().persistent().has(&absent));
        });
    }

    #[test]
    fn an_oversized_expiry_is_clamped_to_the_network_maximum() {
        let env = Env::default();
        let (id, key) = seeded(&env, "K5");
        env.as_contract(&id, || {
            // Would trap inside extend_ttl if it were passed through unclamped.
            assert_eq!(renew_persistent_ttl(&env, &key, u32::MAX), RenewalOutcome::Requested);

            assert!(env.storage().persistent().get_ttl(&key) <= env.storage().max_ttl());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SLACalculatorContract;
    use soroban_sdk::testutils::Ledger as _;

    #[test]
    fn test_bump_stays_within_the_network_maximum() {
        let env = Env::default();
        let max = env.ledger().get().max_entry_ttl;
        assert!(INSTANCE_TTL_BUMP_LEDGERS <= max);
        assert!(MIN_INSTANCE_TTL_LEDGERS <= INSTANCE_TTL_BUMP_LEDGERS);
    }

    #[test]
    fn test_ensure_instance_ttl_does_not_exceed_extension_limits() {
        let env = Env::default();
        let id = env.register_contract(None, SLACalculatorContract);
        // extend_ttl traps if asked to extend past the network maximum, so a
        // clean return proves the configured bump is within limits.
        env.as_contract(&id, || ensure_instance_ttl(&env));
    }

    #[test]
    fn test_ensure_instance_ttl_is_safe_to_call_repeatedly() {
        let env = Env::default();
        let id = env.register_contract(None, SLACalculatorContract);
        env.as_contract(&id, || {
            ensure_instance_ttl(&env);
            ensure_instance_ttl(&env);
            ensure_instance_ttl(&env);
        });
    }

    #[test]
    fn test_ensure_instance_ttl_after_ledgers_advance() {
        let env = Env::default();
        let id = env.register_contract(None, SLACalculatorContract);
        env.as_contract(&id, || ensure_instance_ttl(&env));
        env.ledger().with_mut(|l| l.sequence_number += 50_000);
        env.as_contract(&id, || ensure_instance_ttl(&env));
    }
}
