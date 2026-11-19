use soroban_sdk::{symbol_short, Env, Map, Symbol, Vec};

pub const DEPENDENCY_EVENT: Symbol = symbol_short!("depend");
pub const PARENT_INDEX: Symbol = symbol_short!("dp_idx");
pub const CHILD_INDEX: Symbol = symbol_short!("dc_idx");
pub const MANUAL_STATUS: Symbol = symbol_short!("d_stat");
pub const AUTO_DEGRADED: Symbol = symbol_short!("d_auto");
/// #1020 — root causes that have already emitted a pause transition.
pub const CAUSE_TRANSITION_KEY: Symbol = symbol_short!("d_cause");

pub const STATUS_OPERATIONAL: u32 = 0;
pub const STATUS_DEGRADED: u32 = 1;
pub const STATUS_DOWN: u32 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DependencyError {
    SelfDependency,
    CycleDetected,
}

fn parent_index(env: &Env) -> Map<Symbol, Symbol> {
    env.storage()
        .persistent()
        .get(&PARENT_INDEX)
        .unwrap_or_else(|| Map::new(env))
}

fn child_index(env: &Env) -> Map<Symbol, Vec<Symbol>> {
    env.storage()
        .persistent()
        .get(&CHILD_INDEX)
        .unwrap_or_else(|| Map::new(env))
}

fn manual_status_map(env: &Env) -> Map<Symbol, u32> {
    env.storage()
        .persistent()
        .get(&MANUAL_STATUS)
        .unwrap_or_else(|| Map::new(env))
}

fn auto_flag_map(env: &Env) -> Map<Symbol, bool> {
    env.storage()
        .persistent()
        .get(&AUTO_DEGRADED)
        .unwrap_or_else(|| Map::new(env))
}

fn ancestry_contains(env: &Env, start: &Symbol, target: &Symbol) -> bool {
    let parents = parent_index(env);
    let mut cursor = Some(start.clone());
    while let Some(current) = cursor {
        if current == *target {
            return true;
        }
        cursor = parents.get(current);
    }
    false
}

pub fn would_create_cycle(env: &Env, parent: &Symbol, child: &Symbol) -> bool {
    ancestry_contains(env, parent, child)
}

pub fn register_dependency(
    env: &Env,
    parent: &Symbol,
    child: &Symbol,
) -> Result<(), DependencyError> {
    if parent == child {
        return Err(DependencyError::SelfDependency);
    }
    if would_create_cycle(env, parent, child) {
        return Err(DependencyError::CycleDetected);
    }

    let mut parents = parent_index(env);
    parents.set(child.clone(), parent.clone());
    env.storage().persistent().set(&PARENT_INDEX, &parents);

    let mut children = child_index(env);
    let mut entries = children
        .get(parent.clone())
        .unwrap_or_else(|| Vec::new(env));
    if !entries.contains(child) {
        entries.push_back(child.clone());
    }
    children.set(parent.clone(), entries);
    env.storage().persistent().set(&CHILD_INDEX, &children);

    env.events()
        .publish((DEPENDENCY_EVENT, parent.clone()), child.clone());
    Ok(())
}

pub fn children_of(env: &Env, parent: &Symbol) -> Vec<Symbol> {
    child_index(env)
        .get(parent.clone())
        .unwrap_or_else(|| Vec::new(env))
}

pub fn parent_of(env: &Env, child: &Symbol) -> Option<Symbol> {
    parent_index(env).get(child.clone())
}

pub fn manual_status(env: &Env, site: &Symbol) -> u32 {
    manual_status_map(env)
        .get(site.clone())
        .unwrap_or(STATUS_OPERATIONAL)
}

pub fn report_status(env: &Env, site: &Symbol, status: u32) {
    let mut statuses = manual_status_map(env);
    statuses.set(site.clone(), status);
    env.storage().persistent().set(&MANUAL_STATUS, &statuses);
}

fn set_auto_flag(env: &Env, site: &Symbol, flagged: bool) {
    let mut flags = auto_flag_map(env);
    flags.set(site.clone(), flagged);
    env.storage().persistent().set(&AUTO_DEGRADED, &flags);
}

pub fn is_auto_degraded(env: &Env, site: &Symbol) -> bool {
    auto_flag_map(env).get(site.clone()).unwrap_or(false)
}

pub fn site_status(env: &Env, site: &Symbol) -> u32 {
    let reported = manual_status(env, site);
    if reported == STATUS_DOWN {
        return STATUS_DOWN;
    }
    if is_auto_degraded(env, site) {
        return STATUS_DEGRADED;
    }
    reported
}

pub fn propagate_outage(env: &Env, parent: &Symbol) -> u32 {
    propagate_outage_for_cause(env, parent, parent)
}

/// #1020 — propagate a failure attributed to `cause`.
///
/// Only the first propagation of a given root cause may change state and
/// emit a pause transition. Repeating it is a no-op, while a *different*
/// cause still degrades the site and leaves its own visible status/event.
pub fn propagate_outage_for_cause(env: &Env, parent: &Symbol, cause: &Symbol) -> u32 {
    let mut seen: soroban_sdk::Map<Symbol, bool> = env
        .storage()
        .persistent()
        .get(&CAUSE_TRANSITION_KEY)
        .unwrap_or(soroban_sdk::Map::new(env));

    if seen.get(cause.clone()).unwrap_or(false) {
        return 0;
    }
    seen.set(cause.clone(), true);
    env.storage()
        .persistent()
        .set(&CAUSE_TRANSITION_KEY, &seen);

    let mut flagged = 0u32;
    for child in children_of(env, parent).iter() {
        if manual_status(env, &child) == STATUS_DOWN {
            continue;
        }
        set_auto_flag(env, &child, true);
        flagged += 1;
    }
    // Exactly one transition event per root cause, regardless of how many
    // layers the failure travelled through.
    env.events().publish((DEPENDENCY_EVENT, cause.clone()), parent.clone());
    flagged
}

pub fn clear_outage(env: &Env, parent: &Symbol) -> u32 {
    let mut cleared = 0u32;
    for child in children_of(env, parent).iter() {
        if is_auto_degraded(env, &child) {
            set_auto_flag(env, &child, false);
            cleared += 1;
        }
    }
    cleared
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SLACalculatorContract;

    fn contract(env: &Env) -> soroban_sdk::Address {
        env.register_contract(None, SLACalculatorContract)
    }

    fn site(env: &Env, text: &str) -> Symbol {
        Symbol::new(env, text)
    }

    #[test]
    fn a_site_cannot_depend_on_itself() {
        let env = Env::default();
        let result = env.as_contract(&contract(&env), || {
            let node = site(&env, "core");
            register_dependency(&env, &node, &node)
        });
        assert_eq!(result, Err(DependencyError::SelfDependency));
    }

    #[test]
    fn a_dependency_cycle_is_rejected() {
        let env = Env::default();
        let result = env.as_contract(&contract(&env), || {
            let core = site(&env, "core");
            let edge = site(&env, "edge");
            register_dependency(&env, &core, &edge).expect("core to edge");
            register_dependency(&env, &edge, &core)
        });
        assert_eq!(result, Err(DependencyError::CycleDetected));
    }

    #[test]
    fn registering_stores_both_directions() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let core = site(&env, "core");
            let edge = site(&env, "edge");
            register_dependency(&env, &core, &edge).expect("registered");
            assert_eq!(parent_of(&env, &edge), Some(core.clone()));
            assert_eq!(children_of(&env, &core).len(), 1);
        });
    }

    #[test]
    fn a_parent_outage_degrades_its_children() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let core = site(&env, "core");
            let edge = site(&env, "edge");
            register_dependency(&env, &core, &edge).expect("registered");
            assert_eq!(propagate_outage(&env, &core), 1);
            assert_eq!(site_status(&env, &edge), STATUS_DEGRADED);
            assert!(is_auto_degraded(&env, &edge));
        });
    }

    #[test]
    fn closing_the_parent_outage_clears_the_flag() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let core = site(&env, "core");
            let edge = site(&env, "edge");
            register_dependency(&env, &core, &edge).expect("registered");
            propagate_outage(&env, &core);
            assert_eq!(clear_outage(&env, &core), 1);
            assert_eq!(site_status(&env, &edge), STATUS_OPERATIONAL);
            assert!(!is_auto_degraded(&env, &edge));
        });
    }

    #[test]
    fn a_child_outage_degrades_the_whole_subtree() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let core = site(&env, "core");
            let edge = site(&env, "edge");
            let leaf = site(&env, "leaf");
            register_dependency(&env, &core, &edge).expect("core to edge");
            register_dependency(&env, &edge, &leaf).expect("edge to leaf");
            propagate_outage(&env, &core);
            propagate_outage(&env, &edge);
            assert_eq!(site_status(&env, &edge), STATUS_DEGRADED);
            assert_eq!(site_status(&env, &leaf), STATUS_DEGRADED);
        });
    }

    #[test]
    fn a_manual_outage_is_never_overwritten() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let core = site(&env, "core");
            let edge = site(&env, "edge");
            register_dependency(&env, &core, &edge).expect("registered");
            report_status(&env, &edge, STATUS_DOWN);
            propagate_outage(&env, &core);
            assert_eq!(site_status(&env, &edge), STATUS_DOWN);
        });
    }

    #[test]
    fn clearing_leaves_a_manual_outage_alone() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let core = site(&env, "core");
            let edge = site(&env, "edge");
            register_dependency(&env, &core, &edge).expect("registered");
            report_status(&env, &edge, STATUS_DOWN);
            propagate_outage(&env, &core);
            clear_outage(&env, &core);
            assert_eq!(site_status(&env, &edge), STATUS_DOWN);
        });
    }

    #[test]
    fn an_unregistered_site_stays_operational() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let lonely = site(&env, "lonely");
            assert_eq!(site_status(&env, &lonely), STATUS_OPERATIONAL);
            assert!(!is_auto_degraded(&env, &lonely));
        });
    }

    #[test]
    fn a_site_with_several_children_flags_each_of_them() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let core = site(&env, "core");
            let edge_a = site(&env, "edge_a");
            let edge_b = site(&env, "edge_b");
            register_dependency(&env, &core, &edge_a).expect("a");
            register_dependency(&env, &core, &edge_b).expect("b");
            assert_eq!(propagate_outage(&env, &core), 2);
        });
    }
}

#[cfg(test)]
mod cause_dedup_tests {
    use super::*;
    use soroban_sdk::{testutils::Events as _, Address as _};

    fn contract(env: &Env) -> soroban_sdk::Address {
        env.register_contract(None, SLACalculatorContract)
    }

    #[test]
    fn repeated_propagation_for_one_cause_changes_state_once() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let core = Symbol::new(&env, "core");
            let edge = Symbol::new(&env, "edge");
            let cause = Symbol::new(&env, "provider_down");
            register_dependency(&env, &core, &edge).unwrap();

            assert_eq!(propagate_outage_for_cause(&env, &core, &cause), 1);
            assert_eq!(propagate_outage_for_cause(&env, &core, &cause), 0);
            assert_eq!(propagate_outage_for_cause(&env, &core, &cause), 0);
            assert_eq!(env.events().all().len(), 1);
            assert_eq!(site_status(&env, &edge), STATUS_DEGRADED);
        });
    }

    #[test]
    fn a_distinct_cause_stays_visible() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let core = Symbol::new(&env, "core");
            let edge = Symbol::new(&env, "edge");
            let first = Symbol::new(&env, "provider_down");
            let second = Symbol::new(&env, "dns_down");
            register_dependency(&env, &core, &edge).unwrap();

            assert_eq!(propagate_outage_for_cause(&env, &core, &first), 1);
            assert_eq!(propagate_outage_for_cause(&env, &core, &second), 1);

            // A distinct cause gets its own transition, and both causes
            // remain distinguishable in storage.
            let seen: soroban_sdk::Map<Symbol, bool> = env
                .storage()
                .persistent()
                .get(&CAUSE_TRANSITION_KEY)
                .unwrap();
            assert_eq!(seen.get(first).unwrap(), true);
            assert_eq!(seen.get(second).unwrap(), true);
            assert_eq!(env.events().all().len(), 2);
        });
    }
}
