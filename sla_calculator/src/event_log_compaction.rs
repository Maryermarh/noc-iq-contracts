use soroban_sdk::{contracttype, symbol_short, Env, Map, String, Symbol, Vec};

pub const COMPACTED_EVENT: Symbol = symbol_short!("compact");
pub const SUMMARY_BYTES: u32 = 32;
pub const SUMMARY_KEY: Symbol = symbol_short!("osum");
pub const DETAIL_KEY: Symbol = symbol_short!("odtl");
pub const PROGRESS_KEY: Symbol = symbol_short!("ocprog");

/// Committed progress of a resumable compaction run. Each call commits its
/// progress atomically with the records it handled, so a rerun after an
/// interruption continues from `next_index` and never revisits (or
/// re-publishes events for) records that were already committed.
#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct CompactionProgress {
    /// Records ending before this timestamp are compacted; newer ones are left untouched.
    pub cutoff: u64,
    /// Index into the supplied record list of the next record to examine.
    pub next_index: u32,
    /// Number of records compacted so far in this run.
    pub compacted: u32,
    pub complete: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct DetailedOutageRecord {
    pub outage_id: Symbol,
    pub start_timestamp: u64,
    pub end_timestamp: u64,
    pub severity: u32,
    pub description: String,
    pub metadata: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[contracttype]
pub struct OutageSummary {
    pub outage_id: Symbol,
    pub start_timestamp: u64,
    pub end_timestamp: u64,
    pub severity: u32,
}

pub fn compact(record: &DetailedOutageRecord) -> OutageSummary {
    OutageSummary {
        outage_id: record.outage_id.clone(),
        start_timestamp: record.start_timestamp,
        end_timestamp: record.end_timestamp,
        severity: record.severity,
    }
}

pub fn summary_bytes() -> u32 {
    SUMMARY_BYTES
}

pub fn verbose_bytes(record: &DetailedOutageRecord) -> u32 {
    let fixed: u32 = 4 + 8 + 8 + 4;
    let strings: u32 = 4 + record.description.len() + 4 + record.metadata.len();
    fixed.saturating_add(strings)
}

pub fn byte_reduction(record: &DetailedOutageRecord) -> u32 {
    verbose_bytes(record).saturating_sub(SUMMARY_BYTES)
}

fn summary_map(env: &Env) -> Map<Symbol, OutageSummary> {
    env.storage()
        .persistent()
        .get(&SUMMARY_KEY)
        .unwrap_or_else(|| Map::new(env))
}

fn detail_map(env: &Env) -> Map<Symbol, DetailedOutageRecord> {
    env.storage()
        .persistent()
        .get(&DETAIL_KEY)
        .unwrap_or_else(|| Map::new(env))
}

pub fn store_summary(env: &Env, summary: &OutageSummary) {
    let mut summaries = summary_map(env);
    summaries.set(summary.outage_id.clone(), summary.clone());
    env.storage().persistent().set(&SUMMARY_KEY, &summaries);
    env.events().publish(
        (COMPACTED_EVENT, summary.outage_id.clone()),
        summary_bytes(),
    );
}

pub fn load_summary(env: &Env, outage_id: &Symbol) -> Option<OutageSummary> {
    summary_map(env).get(outage_id.clone())
}

pub fn store_detailed(env: &Env, record: &DetailedOutageRecord) {
    let mut details = detail_map(env);
    details.set(record.outage_id.clone(), record.clone());
    env.storage().persistent().set(&DETAIL_KEY, &details);
}

pub fn load_detailed(env: &Env, outage_id: &Symbol) -> Option<DetailedOutageRecord> {
    detail_map(env).get(outage_id.clone())
}

pub fn evict_details(env: &Env, outage_id: &Symbol) -> bool {
    let mut details = detail_map(env);
    if !details.contains_key(outage_id.clone()) {
        return false;
    }
    details.remove(outage_id.clone());
    env.storage().persistent().set(&DETAIL_KEY, &details);
    true
}

pub fn compact_outage(env: &Env, record: &DetailedOutageRecord) -> OutageSummary {
    let summary = compact(record);
    store_summary(env, &summary);
    evict_details(env, &record.outage_id);
    summary
}

pub fn load_progress(env: &Env) -> Option<CompactionProgress> {
    env.storage().persistent().get(&PROGRESS_KEY)
}

/// Compacts an outage only if it has not already been compacted (a summary
/// exists and the verbose record is gone), so reruns stay idempotent and do
/// not publish duplicate compaction events.
fn compact_outage_once(env: &Env, record: &DetailedOutageRecord) -> bool {
    if load_summary(env, &record.outage_id).is_some() && load_detailed(env, &record.outage_id).is_none()
    {
        return false;
    }
    compact_outage(env, record);
    true
}

/// Resumable compaction. Examines at most `max_per_call` records starting at
/// the committed cursor, compacts those that ended before `cutoff`, leaves
/// newer records (and their summaries/indexes) untouched, and commits the
/// cursor. Calling it again with the same `cutoff` continues where the last
/// committed call stopped; calling it after completion is a no-op. A
/// different `cutoff` starts a fresh run.
pub fn compact_resumable(
    env: &Env,
    records: &Vec<DetailedOutageRecord>,
    cutoff: u64,
    max_per_call: u32,
) -> CompactionProgress {
    let mut progress = match load_progress(env) {
        Some(p) if p.cutoff == cutoff => p,
        _ => CompactionProgress {
            cutoff,
            next_index: 0,
            compacted: 0,
            complete: false,
        },
    };
    if progress.complete {
        return progress;
    }

    let mut handled: u32 = 0;
    while progress.next_index < records.len() && handled < max_per_call {
        if let Some(record) = records.get(progress.next_index) {
            if record.end_timestamp < cutoff && compact_outage_once(env, &record) {
                progress.compacted += 1;
            }
        }
        progress.next_index += 1;
        handled += 1;
    }
    if progress.next_index >= records.len() {
        progress.complete = true;
    }
    env.storage().persistent().set(&PROGRESS_KEY, &progress);
    progress
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SLACalculatorContract;

    fn contract(env: &Env) -> soroban_sdk::Address {
        env.register_contract(None, SLACalculatorContract)
    }

    fn record(env: &Env, description: &str) -> DetailedOutageRecord {
        DetailedOutageRecord {
            outage_id: Symbol::new(env, "OUT1"),
            start_timestamp: 1_000,
            end_timestamp: 4_600,
            severity: 3,
            description: String::from_str(env, description),
            metadata: String::from_str(env, "region=eu-west"),
        }
    }

    #[test]
    fn compaction_preserves_the_audit_trail() {
        let env = Env::default();
        let detailed = record(&env, "gateway timeouts");
        let summary = compact(&detailed);
        assert_eq!(summary.outage_id, detailed.outage_id);
        assert_eq!(summary.start_timestamp, 1_000);
        assert_eq!(summary.end_timestamp, 4_600);
        assert_eq!(summary.severity, 3);
    }

    #[test]
    fn a_summary_fits_the_thirty_two_byte_budget() {
        assert_eq!(summary_bytes(), 32);
    }

    #[test]
    fn compaction_reduces_storage_bytes() {
        let env = Env::default();
        let detailed = record(
            &env,
            "gateway timeouts across the eu-west ingress tier requiring a rolling restart",
        );
        let before = verbose_bytes(&detailed);
        assert!(before > summary_bytes());
        assert_eq!(byte_reduction(&detailed), before - summary_bytes());
    }

    #[test]
    fn savings_grow_with_the_verbose_metadata() {
        let env = Env::default();
        let short = record(&env, "brief");
        let long = record(&env, "a considerably longer description of the same outage");
        assert!(byte_reduction(&long) > byte_reduction(&short));
    }

    #[test]
    fn verbose_size_accounts_for_both_strings() {
        let env = Env::default();
        let detailed = record(&env, "12345");
        let expected = 4 + 8 + 8 + 4 + 4 + 5 + 4 + detailed.metadata.len();
        assert_eq!(verbose_bytes(&detailed), expected);
    }

    #[test]
    fn a_stored_summary_can_be_read_back() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let detailed = record(&env, "gateway timeouts");
            let summary = compact_outage(&env, &detailed);
            let stored = load_summary(&env, &detailed.outage_id).expect("summary stored");
            assert_eq!(stored, summary);
        });
    }

    #[test]
    fn compaction_evicts_the_verbose_record() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let detailed = record(&env, "gateway timeouts");
            store_detailed(&env, &detailed);
            assert!(load_detailed(&env, &detailed.outage_id).is_some());
            compact_outage(&env, &detailed);
            assert!(load_detailed(&env, &detailed.outage_id).is_none());
            assert!(load_summary(&env, &detailed.outage_id).is_some());
        });
    }

    #[test]
    fn evicting_a_missing_record_is_harmless() {
        let env = Env::default();
        let evicted = env.as_contract(&contract(&env), || {
            evict_details(&env, &Symbol::new(&env, "OUT9"))
        });
        assert!(!evicted);
    }
    fn record_at(env: &Env, id: &str, end: u64) -> DetailedOutageRecord {
        DetailedOutageRecord {
            outage_id: Symbol::new(env, id),
            start_timestamp: end - 100,
            end_timestamp: end,
            severity: 2,
            description: String::from_str(env, "outage"),
            metadata: String::from_str(env, "meta"),
        }
    }

    fn five_records(env: &Env) -> Vec<DetailedOutageRecord> {
        let mut v: Vec<DetailedOutageRecord> = Vec::new(env);
        // OUT1..OUT3 are older than the cutoff (1_000); OUT4 and OUT5 are recent.
        v.push_back(record_at(env, "OUT1", 500));
        v.push_back(record_at(env, "OUT2", 600));
        v.push_back(record_at(env, "OUT3", 700));
        v.push_back(record_at(env, "OUT4", 2_000));
        v.push_back(record_at(env, "OUT5", 3_000));
        v
    }

    #[test]
    fn interrupted_compaction_resumes_from_committed_progress() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let records = five_records(&env);
            for i in 0..records.len() {
                store_detailed(&env, &records.get(i).unwrap());
            }

            // First call commits two records and then "dies" (returns early).
            let first = compact_resumable(&env, &records, 1_000, 2);
            assert!(!first.complete);
            assert_eq!(first.next_index, 2);
            assert_eq!(first.compacted, 2);
            assert!(load_summary(&env, &Symbol::new(&env, "OUT3")).is_none());

            // Rerun finishes without redoing OUT1/OUT2.
            let second = compact_resumable(&env, &records, 1_000, 10);
            assert!(second.complete);
            assert_eq!(second.compacted, 3);
            for id in ["OUT1", "OUT2", "OUT3"] {
                let sym = Symbol::new(&env, id);
                assert!(load_summary(&env, &sym).is_some());
                assert!(load_detailed(&env, &sym).is_none());
            }
        });
    }

    #[test]
    fn recent_records_are_left_queryable() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let records = five_records(&env);
            for i in 0..records.len() {
                store_detailed(&env, &records.get(i).unwrap());
            }
            compact_resumable(&env, &records, 1_000, 100);
            for id in ["OUT4", "OUT5"] {
                let sym = Symbol::new(&env, id);
                assert!(load_detailed(&env, &sym).is_some());
                assert!(load_summary(&env, &sym).is_none());
            }
        });
    }

    #[test]
    fn rerunning_a_completed_compaction_is_idempotent() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let records = five_records(&env);
            for i in 0..records.len() {
                store_detailed(&env, &records.get(i).unwrap());
            }
            let done = compact_resumable(&env, &records, 1_000, 100);
            assert!(done.complete);
            let again = compact_resumable(&env, &records, 1_000, 100);
            assert_eq!(done, again);
            assert_eq!(load_progress(&env), Some(again));
        });
    }

    #[test]
    fn a_different_cutoff_starts_a_fresh_run() {
        let env = Env::default();
        env.as_contract(&contract(&env), || {
            let records = five_records(&env);
            for i in 0..records.len() {
                store_detailed(&env, &records.get(i).unwrap());
            }
            compact_resumable(&env, &records, 1_000, 100);
            let wider = compact_resumable(&env, &records, 2_500, 100);
            assert!(wider.complete);
            // Only OUT4 is newly compacted; OUT1..OUT3 were already done.
            assert_eq!(wider.compacted, 1);
            assert!(load_detailed(&env, &Symbol::new(&env, "OUT5")).is_some());
        });
    }
}
