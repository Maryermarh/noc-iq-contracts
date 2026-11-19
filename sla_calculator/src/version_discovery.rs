use soroban_sdk::Env;

pub const PROTOCOL_VERSION: u32 = 1;
pub const STORAGE_VERSION: u32 = 1;

/// Returns `(protocol_version, storage_version)` for off-chain integrators.
pub fn get_version(_env: &Env) -> (u32, u32) {
    (PROTOCOL_VERSION, STORAGE_VERSION)
}

/// Both versions an off-chain client needs before it decodes anything: the executable version
/// (what the binary does) and the storage schema version (how its state is laid out).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionDiscovery {
    pub contract_version: u32,
    pub storage_version: u32,
}

/// Returns the contract version together with the storage schema version.
///
/// Both values are compile-time constants of the running binary, so this is a pure read: it does
/// not touch storage, does not depend on what is currently stored (a deployment that has been
/// upgraded but not yet migrated still reports its own schema version), and does not emit events.
pub fn discover_versions(env: &Env) -> VersionDiscovery {
    let (contract_version, storage_version) = get_version(env);
    VersionDiscovery {
        contract_version,
        storage_version,
    }
}

/// Returns the contract's protocol version (the first element of
/// [`get_version`]) as a single `u32`.
pub fn get_contract_version(env: &Env) -> u32 {
    get_version(env).0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_contract_version_matches_protocol_version() {
        let env = Env::default();
        assert_eq!(get_contract_version(&env), PROTOCOL_VERSION);
    }

    #[test]
    fn test_get_version_reports_protocol_and_storage_versions() {
        let env = Env::default();
        assert_eq!(get_version(&env), (PROTOCOL_VERSION, STORAGE_VERSION));
    }

    #[test]
    fn test_version_discovery_is_stable_across_calls() {
        let env = Env::default();
        assert_eq!(get_contract_version(&env), get_contract_version(&env));
    }
}

#[cfg(test)]
mod discovery_tests {
    use super::*;
    use crate::SLACalculatorContract;
    use soroban_sdk::{symbol_short, testutils::Events as _};

    #[test]
    fn discovery_reports_both_versions() {
        let env = Env::default();
        assert_eq!(
            discover_versions(&env),
            VersionDiscovery {
                contract_version: PROTOCOL_VERSION,
                storage_version: STORAGE_VERSION,
            }
        );
    }

    #[test]
    fn the_reported_schema_version_is_the_one_the_contract_enforces() {
        // Guards against the three copies of the storage version drifting apart.
        assert_eq!(STORAGE_VERSION, crate::STORAGE_VERSION);
        assert_eq!(STORAGE_VERSION, crate::storage_version::EXPECTED_STORAGE_VERSION);
    }

    #[test]
    fn discovery_is_read_only_and_ignores_the_stored_version() {
        let env = Env::default();
        let id = env.register_contract(None, SLACalculatorContract);
        env.as_contract(&id, || {
            // An upgraded-but-not-migrated deployment: storage still carries the old stamp.
            env.storage().instance().set(&symbol_short!("VER"), &0u32);

            let found = discover_versions(&env);

            assert_eq!(found.storage_version, STORAGE_VERSION);
            assert_eq!(env.storage().instance().get::<_, u32>(&symbol_short!("VER")), Some(0));
        });
        assert_eq!(env.events().all().len(), 0);
    }
}
