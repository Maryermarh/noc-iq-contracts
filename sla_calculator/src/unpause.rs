use soroban_sdk::{symbol_short, Address, Env, String, Symbol};

use crate::pause_action::{active_incident, PAUSE_INCIDENT_KEY};

const PAUSED_KEY: Symbol = symbol_short!("PAUSED");
const PAUSE_INFO_KEY: Symbol = symbol_short!("PAUSEINF");
const CONTRACT_UNPAUSED_EVENT: Symbol = symbol_short!("unpaused");

/// Why [`unpause_for_incident`] refused to clear the pause.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnpauseError {
    /// The reference does not match the pause in force: a newer, unrelated pause is active.
    IncidentMismatch,
    /// The pause in force is not scoped to an incident (or there is none); use [`unpause`].
    NoScopedPause,
}

/// Admin-only: clears the paused flag and pause metadata. This is the unconditional admin
/// override: it also clears any incident reference.
pub fn unpause(env: &Env, admin: &Address) {
    admin.require_auth();
    env.storage().instance().set(&PAUSED_KEY, &false);
    env.storage().instance().remove(&PAUSE_INFO_KEY);
    env.storage().instance().remove(&PAUSE_INCIDENT_KEY);
    env.events()
        .publish((CONTRACT_UNPAUSED_EVENT,), admin.clone());
}

/// Admin-only: recovers from a scoped pause, but only if `incident_ref` matches the incident the
/// pause in force was raised for. A stale reference (a different, newer pause is active) is
/// rejected and leaves the paused flag, the pause metadata and the incident reference exactly as
/// they were.
pub fn unpause_for_incident(
    env: &Env,
    admin: &Address,
    incident_ref: &String,
) -> Result<(), UnpauseError> {
    admin.require_auth();
    match active_incident(env) {
        None => Err(UnpauseError::NoScopedPause),
        Some(current) if current != *incident_ref => Err(UnpauseError::IncidentMismatch),
        Some(_) => {
            unpause(env, admin);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SLACalculatorContract;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, SLACalculatorContract);
        let admin = Address::generate(&env);
        (env, id, admin)
    }

    #[test]
    fn test_unpause_clears_flag_and_pause_info() {
        let (env, id, admin) = setup();
        env.as_contract(&id, || {
            env.storage().instance().set(&PAUSED_KEY, &true);
            env.storage().instance().set(&PAUSE_INFO_KEY, &7u32);
            unpause(&env, &admin);
            assert_eq!(env.storage().instance().get::<Symbol, bool>(&PAUSED_KEY), Some(false));
            assert!(!env.storage().instance().has(&PAUSE_INFO_KEY));
        });
    }

    #[test]
    fn test_unpause_is_idempotent_when_not_paused() {
        let (env, id, admin) = setup();
        env.as_contract(&id, || {
            unpause(&env, &admin);
            unpause(&env, &admin);
            assert_eq!(env.storage().instance().get::<Symbol, bool>(&PAUSED_KEY), Some(false));
        });
    }

    fn incident(env: &Env, id: &str) -> String {
        String::from_str(env, id)
    }

    fn pause_info_reason(env: &Env) -> Option<String> {
        env.storage()
            .instance()
            .get::<Symbol, crate::pause_action::PauseInfo>(&PAUSE_INFO_KEY)
            .map(|info| info.reason)
    }

    #[test]
    fn test_matching_incident_reference_recovers_the_pause() {
        let (env, id, admin) = setup();
        env.as_contract(&id, || {
            crate::pause_action::pause_with_incident(
                &env,
                &admin,
                String::from_str(&env, "db failover"),
                incident(&env, "INC-1"),
            );

            assert_eq!(unpause_for_incident(&env, &admin, &incident(&env, "INC-1")), Ok(()));

            assert_eq!(env.storage().instance().get::<Symbol, bool>(&PAUSED_KEY), Some(false));
            assert!(!env.storage().instance().has(&PAUSE_INFO_KEY));
            assert_eq!(active_incident(&env), None);
        });
    }

    #[test]
    fn test_stale_incident_reference_is_rejected_and_preserves_the_active_pause() {
        let (env, id, admin) = setup();
        env.as_contract(&id, || {
            crate::pause_action::pause_with_incident(
                &env,
                &admin,
                String::from_str(&env, "first outage"),
                incident(&env, "INC-1"),
            );
            // A newer, unrelated pause replaces the first.
            crate::pause_action::pause_with_incident(
                &env,
                &admin,
                String::from_str(&env, "second outage"),
                incident(&env, "INC-2"),
            );

            let result = unpause_for_incident(&env, &admin, &incident(&env, "INC-1"));

            assert_eq!(result, Err(UnpauseError::IncidentMismatch));
            assert_eq!(env.storage().instance().get::<Symbol, bool>(&PAUSED_KEY), Some(true));
            assert_eq!(pause_info_reason(&env), Some(String::from_str(&env, "second outage")));
            assert_eq!(active_incident(&env), Some(incident(&env, "INC-2")));
        });
    }

    #[test]
    fn test_scoped_unpause_does_not_clear_an_unscoped_pause() {
        let (env, id, admin) = setup();
        env.as_contract(&id, || {
            crate::pause_action::pause(&env, &admin, String::from_str(&env, "maintenance"));

            let result = unpause_for_incident(&env, &admin, &incident(&env, "INC-1"));

            assert_eq!(result, Err(UnpauseError::NoScopedPause));
            assert_eq!(env.storage().instance().get::<Symbol, bool>(&PAUSED_KEY), Some(true));
            assert!(env.storage().instance().has(&PAUSE_INFO_KEY));
        });
    }

    #[test]
    fn test_plain_pause_supersedes_an_earlier_scoped_pause() {
        let (env, id, admin) = setup();
        env.as_contract(&id, || {
            crate::pause_action::pause_with_incident(
                &env,
                &admin,
                String::from_str(&env, "first"),
                incident(&env, "INC-1"),
            );
            crate::pause_action::pause(&env, &admin, String::from_str(&env, "later, unscoped"));

            assert_eq!(active_incident(&env), None);
            assert_eq!(
                unpause_for_incident(&env, &admin, &incident(&env, "INC-1")),
                Err(UnpauseError::NoScopedPause)
            );
        });
    }

    #[test]
    fn test_admin_override_unpause_also_clears_the_incident_reference() {
        let (env, id, admin) = setup();
        env.as_contract(&id, || {
            crate::pause_action::pause_with_incident(
                &env,
                &admin,
                String::from_str(&env, "outage"),
                incident(&env, "INC-1"),
            );

            unpause(&env, &admin);

            assert_eq!(active_incident(&env), None);
            assert_eq!(env.storage().instance().get::<Symbol, bool>(&PAUSED_KEY), Some(false));
        });
    }

    #[test]
    #[should_panic]
    fn test_scoped_unpause_without_auth_panics() {
        let env = Env::default();
        let id = env.register_contract(None, SLACalculatorContract);
        let admin = Address::generate(&env);
        env.as_contract(&id, || {
            let _ = unpause_for_incident(&env, &admin, &incident(&env, "INC-1"));
        });
    }

    #[test]
    #[should_panic]
    fn test_unpause_without_auth_panics() {
        let env = Env::default();
        let id = env.register_contract(None, SLACalculatorContract);
        let admin = Address::generate(&env);
        env.as_contract(&id, || unpause(&env, &admin));
    }
}
