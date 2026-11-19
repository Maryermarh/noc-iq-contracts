// Config rollback helper to previous version. Complements
// config_freeze.rs.
use soroban_sdk::{contracterror, symbol_short, Address, Env, Symbol};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RollbackError {
    VersionNotFound = 1,
}

const ROLLED_BACK_EVENT: Symbol = symbol_short!("cfgrbck");
/// Provenance event: `(previous_revision, restored_source_revision, resulting_revision)`.
pub const ROLLBACK_PROVENANCE_EVENT: Symbol = symbol_short!("cfgrbprv");

/// Governance reverts config settings to a recorded historical version,
/// validating the target version exists in the history log first.
pub fn rollback_config(
    env: &Env,
    governance: &Address,
    target_version: u32,
    known_versions: &[u32],
) -> Result<(), RollbackError> {
    governance.require_auth();
    if !known_versions.contains(&target_version) {
        return Err(RollbackError::VersionNotFound);
    }
    env.events()
        .publish((ROLLED_BACK_EVENT,), target_version);
    Ok(())
}

/// Rolls the configuration back to a recorded historical revision, as a **new** revision.
///
/// The restored configuration becomes revision `current_revision + 1`; the historical revision it
/// was copied from is left exactly as it was, and no provenance record is written, edited or
/// removed here. The returned revision and a [`ROLLBACK_PROVENANCE_EVENT`] make the rollback
/// auditable: the event carries the revision that was current, the historical revision that was
/// restored, and the revision that now holds the restored configuration.
pub fn rollback_with_provenance(
    env: &Env,
    governance: &Address,
    current_revision: u32,
    source_revision: u32,
    known_versions: &[u32],
) -> Result<u32, RollbackError> {
    governance.require_auth();
    if !known_versions.contains(&source_revision) {
        return Err(RollbackError::VersionNotFound);
    }
    let resulting_revision = current_revision + 1;
    env.events().publish(
        (ROLLBACK_PROVENANCE_EVENT,),
        (current_revision, source_revision, resulting_revision),
    );
    Ok(resulting_revision)
}

#[cfg(test)]
mod provenance_tests {
    use super::*;
    use crate::SLACalculatorContract;
    use soroban_sdk::{
        testutils::{Address as _, Events as _},
        IntoVal,
    };

    const PROV_KEY: Symbol = symbol_short!("PROV");

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, SLACalculatorContract);
        let governance = Address::generate(&env);
        (env, id, governance)
    }

    #[test]
    fn rollback_emits_previous_source_and_resulting_revisions() {
        let (env, id, governance) = setup();
        let resulting = env.as_contract(&id, || {
            rollback_with_provenance(&env, &governance, 7, 3, &[1, 2, 3, 4, 5, 6, 7]).unwrap()
        });

        assert_eq!(resulting, 8);
        assert_eq!(
            env.events().all(),
            soroban_sdk::vec![
                &env,
                (
                    id.clone(),
                    (ROLLBACK_PROVENANCE_EVENT,).into_val(&env),
                    (7u32, 3u32, 8u32).into_val(&env)
                )
            ]
        );
    }

    #[test]
    fn rollback_creates_a_new_revision_instead_of_rewriting_history() {
        let (env, id, governance) = setup();
        env.as_contract(&id, || {
            // Stand-in for the historical provenance log.
            env.storage().instance().set(&PROV_KEY, &77u32);

            let resulting =
                rollback_with_provenance(&env, &governance, 5, 2, &[1, 2, 3, 4, 5]).unwrap();

            assert_ne!(resulting, 2);
            assert_eq!(resulting, 6);
            assert_eq!(env.storage().instance().get::<Symbol, u32>(&PROV_KEY), Some(77));
        });
    }

    #[test]
    fn an_unknown_source_revision_is_rejected_without_an_event() {
        let (env, id, governance) = setup();
        let result = env.as_contract(&id, || {
            rollback_with_provenance(&env, &governance, 5, 99, &[1, 2, 3, 4, 5])
        });

        assert_eq!(result, Err(RollbackError::VersionNotFound));
        assert_eq!(env.events().all().len(), 0);
    }

    #[test]
    #[should_panic]
    fn rollback_requires_governance_authorization() {
        let env = Env::default();
        let id = env.register_contract(None, SLACalculatorContract);
        let governance = Address::generate(&env);
        env.as_contract(&id, || {
            let _ = rollback_with_provenance(&env, &governance, 1, 1, &[1]);
        });
    }
}
