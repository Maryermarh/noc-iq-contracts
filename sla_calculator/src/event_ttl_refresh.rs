use soroban_sdk::{Env, Symbol, Vec};

pub const TTL_THRESHOLD_LEDGERS: u32 = 100_000;
pub const TTL_EXTEND_TO_LEDGERS: u32 = 500_000;
const _: () = assert!(TTL_EXTEND_TO_LEDGERS > TTL_THRESHOLD_LEDGERS);

pub fn needs_refresh(remaining_ledgers: u32) -> bool {
    remaining_ledgers < TTL_THRESHOLD_LEDGERS
}

/// Returns the larger of the current TTL and the requested extension so a
/// refresh can never shorten an existing TTL.
pub fn guarded_extend_to(current_remaining: u32, requested_extend_to: u32) -> u32 {
    if requested_extend_to < current_remaining {
        current_remaining
    } else {
        requested_extend_to
    }
}

pub fn refresh_outage_index_ttl(env: &Env, key: &Symbol) -> bool {
    if !env.storage().persistent().has(key) {
        return false;
    }
    let current = env.storage().persistent().get_ttl(key);
    let target = guarded_extend_to(current, TTL_EXTEND_TO_LEDGERS);
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD_LEDGERS, target);
    true
}

/// #1029 — an entry with no remaining lifetime is expired.
pub fn is_expired(remaining_ledgers: u32) -> bool {
    remaining_ledgers == 0
}

/// #1029 — refresh only records that are still live.
///
/// Reading an expired record must not resurrect it or make stale history look
/// active again: a zero remaining TTL returns `false` without extending.
pub fn refresh_outage_index_ttl_if_live(env: &Env, key: &Symbol) -> bool {
    if !env.storage().persistent().has(key) {
        return false;
    }
    let current = env.storage().persistent().get_ttl(key);
    if is_expired(current) {
        return false;
    }
    let target = guarded_extend_to(current, TTL_EXTEND_TO_LEDGERS);
    env.storage()
        .persistent()
        .extend_ttl(key, TTL_THRESHOLD_LEDGERS, target);
    true
}

/// Read an event record without touching its TTL.
pub fn read_event_record(env: &Env, key: &Symbol) -> Option<u32> {
    env.storage().persistent().get(key)
}

pub fn refresh_many(env: &Env, keys: &Vec<Symbol>) -> u32 {
    let mut refreshed = 0u32;
    for key in keys.iter() {
        if refresh_outage_index_ttl(env, &key) {
            refreshed += 1;
        }
    }
    refreshed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SLACalculatorContract;
    use soroban_sdk::testutils::{storage::Persistent as _, Ledger as _};

    fn contract(env: &Env) -> soroban_sdk::Address {
        env.register_contract(None, SLACalculatorContract)
    }

    fn seed(env: &Env, key: &Symbol) {
        env.storage().persistent().set(key, &42u32);
    }

    #[test]
    fn an_entry_below_the_threshold_is_refreshed() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let key = Symbol::new(&env, "OUT1");
            seed(&env, &key);
            let before = env.storage().persistent().get_ttl(&key);
            assert!(needs_refresh(before));
            assert!(refresh_outage_index_ttl(&env, &key));
            let after = env.storage().persistent().get_ttl(&key);
            assert!(after >= TTL_EXTEND_TO_LEDGERS);
        });
    }

    #[test]
    fn a_comfortable_entry_is_left_untouched() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let key = Symbol::new(&env, "OUT1");
            seed(&env, &key);
            env.storage().persistent().extend_ttl(
                &key,
                TTL_EXTEND_TO_LEDGERS,
                TTL_EXTEND_TO_LEDGERS * 2,
            );
            let before = env.storage().persistent().get_ttl(&key);
            assert!(!needs_refresh(before));
            refresh_outage_index_ttl(&env, &key);
            assert_eq!(env.storage().persistent().get_ttl(&key), before);
        });
    }

    #[test]
    fn an_entry_aging_past_the_threshold_is_caught() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let key = Symbol::new(&env, "OUT1");
            seed(&env, &key);
            env.storage()
                .persistent()
                .extend_ttl(&key, 50_000, TTL_THRESHOLD_LEDGERS + 1_000);
            let before = env.storage().persistent().get_ttl(&key);
            assert!(!needs_refresh(before));
            env.ledger().set_sequence_number(2_000);
            assert!(needs_refresh(env.storage().persistent().get_ttl(&key)));
            assert!(refresh_outage_index_ttl(&env, &key));
            assert!(env.storage().persistent().get_ttl(&key) >= TTL_EXTEND_TO_LEDGERS);
        });
    }

    #[test]
    fn a_missing_entry_is_not_refreshed() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let absent = Symbol::new(&env, "OUT404");
            assert!(!refresh_outage_index_ttl(&env, &absent));
        });
    }

    #[test]
    fn the_threshold_helper_matches_the_bump_size() {
        assert!(needs_refresh(0));
        assert!(needs_refresh(TTL_THRESHOLD_LEDGERS - 1));
        assert!(!needs_refresh(TTL_THRESHOLD_LEDGERS));
    }

    #[test]
    fn a_batch_reports_how_many_entries_were_refreshed() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let present = Symbol::new(&env, "OUT1");
            let absent = Symbol::new(&env, "OUT2");
            seed(&env, &present);
            let mut keys = Vec::new(&env);
            keys.push_back(present);
            keys.push_back(absent);
            assert_eq!(refresh_many(&env, &keys), 1);
        });
    }

    #[test]
    fn refreshing_twice_is_harmless() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let key = Symbol::new(&env, "OUT1");
            seed(&env, &key);
            assert!(refresh_outage_index_ttl(&env, &key));
            assert!(refresh_outage_index_ttl(&env, &key));
        });
    }

    #[test]
    fn guarded_extend_to_never_shortens_a_ttl() {
        assert_eq!(guarded_extend_to(600_000, TTL_EXTEND_TO_LEDGERS), 600_000);
        assert_eq!(
            guarded_extend_to(10, TTL_EXTEND_TO_LEDGERS),
            TTL_EXTEND_TO_LEDGERS
        );
    }

    #[test]
    fn refresh_does_not_regress_a_large_ttl() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let key = Symbol::new(&env, "OUT1");
            seed(&env, &key);
            env.storage()
                .persistent()
                .extend_ttl(&key, 600_000, 1_000_000);
            let before = env.storage().persistent().get_ttl(&key);
            refresh_outage_index_ttl(&env, &key);
            let after = env.storage().persistent().get_ttl(&key);
            assert!(after >= before);
        });
    }
}

#[cfg(test)]
mod expired_read_tests {
    use super::*;
    use crate::SLACalculatorContract;
    use soroban_sdk::testutils::{storage::Persistent as _, Ledger as _};

    #[test]
    fn zero_remaining_ledgers_is_expired() {
        assert!(is_expired(0));
        assert!(!is_expired(1));
        assert!(!is_expired(TTL_THRESHOLD_LEDGERS));
    }

    #[test]
    fn reading_an_absent_record_does_not_revive_it() {
        let env = Env::default();
        let contract = env.register_contract(None, SLACalculatorContract);
        env.as_contract(&contract, || {
            let absent = Symbol::new(&env, "OUT404");
            assert_eq!(read_event_record(&env, &absent), None);
            assert!(!refresh_outage_index_ttl_if_live(&env, &absent));
            assert!(!env.storage().persistent().has(&absent));
        });
    }

    #[test]
    fn a_live_record_is_refreshed_to_the_retention_target() {
        let env = Env::default();
        let contract = env.register_contract(None, SLACalculatorContract);
        env.as_contract(&contract, || {
            let key = Symbol::new(&env, "OUT1");
            env.storage().persistent().set(&key, &42u32);
            assert_eq!(read_event_record(&env, &key), Some(42));
            assert!(refresh_outage_index_ttl_if_live(&env, &key));
            assert!(env.storage().persistent().get_ttl(&key) >= TTL_EXTEND_TO_LEDGERS);
        });
    }
}
