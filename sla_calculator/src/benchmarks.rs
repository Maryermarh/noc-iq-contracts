#![cfg(test)]

extern crate std;

use soroban_sdk::{symbol_short, Address, Env};
use std::string::String;

use crate::{SLACalculatorContract, SLAConfig};

/// Benchmark: Contract initialization overhead
#[test]
fn bench_initialize() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);

    let _ = client.initialize(&admin, &operator);
}

/// Benchmark: Config read performance
#[test]
fn bench_get_config() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    let _ = client.get_config(&symbol_short!("critical"));
    let _ = client.get_config(&symbol_short!("high"));
    let _ = client.get_config(&symbol_short!("medium"));
    let _ = client.get_config(&symbol_short!("low"));
}

/// Benchmark: SLA calculation (view-only) performance
#[test]
fn bench_calculate_sla_view() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Benchmark: SLA met case
    let _ = client.calculate_sla_view(&symbol_short!("out_b1"), &symbol_short!("high"), &10);

    // Benchmark: SLA violated case
    let _ = client.calculate_sla_view(&symbol_short!("out_b2"), &symbol_short!("high"), &60);
}

/// Benchmark: Full SLA calculation with persistence (operator)
#[test]
fn bench_calculate_sla_full() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Multiple calculations to measure average
    for i in 0..10 {
        let outage_id = symbol_short!(&format!("out_{}", i));
        let _ = client.calculate_sla(&operator, &outage_id, &symbol_short!("high"), &(10 + i * 5));
    }
}

/// Benchmark: History pagination performance
#[test]
fn bench_history_pagination() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Populate history
    for i in 0..100 {
        let outage_id = symbol_short!(&format!("out_{}", i));
        let _ = client.calculate_sla(&operator, &outage_id, &symbol_short!("high"), &(10 + i));
    }

    // Benchmark pagination
    let _ = client.get_history_page(&0, &10);
    let _ = client.get_history_page(&50, &10);
    let _ = client.get_history_page(&90, &10);
}

/// Benchmark: Config snapshot generation
#[test]
fn bench_config_snapshot() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Multiple snapshot reads
    for _ in 0..10 {
        let _ = client.get_config_snapshot();
    }
}

/// Benchmark: Version hash computation
#[test]
fn bench_config_version_hash() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Multiple hash computations
    for _ in 0..10 {
        let _ = client.get_config_version_hash();
    }
}

/// Benchmark: Stats query performance
#[test]
fn bench_get_stats() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Multiple stats queries
    for _ in 0..10 {
        let _ = client.get_stats();
    }
}

/// Benchmark: Pause/unpause cycle
#[test]
fn bench_pause_unpause() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Multiple pause/unpause cycles
    for _ in 0..10 {
        let _ = client.pause(&admin, &String::from_str(&env, "benchmark"));
        let _ = client.unpause(&admin);
    }
}

/// Benchmark: History by outage query
#[test]
fn bench_history_by_outage() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Create multiple calculations for same outage
    for i in 0..10 {
        let _ = client.calculate_sla(&operator, &symbol_short!("out_rep"), &symbol_short!("high"), &(10 + i));
    }

    // Query by outage
    let _ = client.get_history_by_outage(&symbol_short!("out_rep"));
    let _ = client.get_latest_by_outage(&symbol_short!("out_rep"));
}

/// Benchmark: Full contract metadata retrieval
#[test]
fn bench_get_contract_metadata() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Multiple metadata queries
    for _ in 0..10 {
        let _ = client.get_contract_metadata();
        let _ = client.get_result_schema();
        let _ = client.get_failure_schema();
    }
}

/// Benchmark: Version negotiation endpoint
#[test]
fn bench_get_version_info() {
    let env = Env::default();
    let contract_id = env.register_contract(None, SLACalculatorContract);
    let client = SLACalculatorContract::new_client(&env, &contract_id);

    let admin = Address::generate(&env);
    let operator = Address::generate(&env);
    client.initialize(&admin, &operator);

    // Multiple version queries
    for _ in 0..10 {
        let _ = client.get_version_info();
        let _ = client.get_migration_state();
    }
}

// -----------------------------------------------------------------------
// #1024 — separate cold and warm storage cost baselines
// -----------------------------------------------------------------------

/// Storage costs split into first-write (cold) and steady-state (warm) paths.
///
/// Keeping these separate makes a change to the storage layout reviewable:
/// a cold-write regression is not hidden by fast warm reads in an average.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StorageCostBaseline {
    /// Cost of the first write to a key (cold path).
    pub cold_write: u64,
    /// Cost of re-writing an existing key (warm path).
    pub warm_write: u64,
    /// Cost of reading an existing key (warm path).
    pub warm_read: u64,
}

/// Render a baseline with explicit cold/warm labels for the report.
pub fn format_storage_baseline(label: &str, baseline: &StorageCostBaseline) -> String {
    std::format!(
        "{label}: cold_write={}, warm_write={}, warm_read={}",
        baseline.cold_write,
        baseline.warm_write,
        baseline.warm_read
    )
}

/// Compare a measured baseline against its budget. Either path exceeding its
/// budget produces a message that names the path and both values.
pub fn compare_storage_baseline(
    measured: &StorageCostBaseline,
    budget: &StorageCostBaseline,
) -> Result<(), String> {
    if measured.cold_write > budget.cold_write {
        return Err(std::format!(
            "cold write path regressed: {} > budget {}",
            measured.cold_write,
            budget.cold_write
        ));
    }
    if measured.warm_write > budget.warm_write {
        return Err(std::format!(
            "warm write path regressed: {} > budget {}",
            measured.warm_write,
            budget.warm_write
        ));
    }
    if measured.warm_read > budget.warm_read {
        return Err(std::format!(
            "warm read path regressed: {} > budget {}",
            measured.warm_read,
            budget.warm_read
        ));
    }
    Ok(())
}

#[cfg(test)]
mod cold_warm_baseline_tests {
    use super::*;

    fn budget() -> StorageCostBaseline {
        StorageCostBaseline {
            cold_write: 1_000,
            warm_write: 400,
            warm_read: 100,
        }
    }

    #[test]
    fn the_report_labels_cold_and_warm_paths_separately() {
        let report = format_storage_baseline("SLA calc", &budget());
        assert!(report.contains("cold_write=1000"));
        assert!(report.contains("warm_write=400"));
        assert!(report.contains("warm_read=100"));
    }

    #[test]
    fn a_cold_write_regression_names_the_cold_path() {
        let mut measured = budget();
        measured.cold_write += 1;
        let error = compare_storage_baseline(&measured, &budget()).unwrap_err();
        assert!(error.contains("cold write path"), "{error}");
    }

    #[test]
    fn a_warm_path_regression_names_the_warm_path() {
        let mut measured = budget();
        measured.warm_read += 1;
        let error = compare_storage_baseline(&measured, &budget()).unwrap_err();
        assert!(error.contains("warm read path"), "{error}");
    }

    #[test]
    fn a_baseline_within_budget_passes() {
        assert_eq!(compare_storage_baseline(&budget(), &budget()), Ok(()));
    }
}
