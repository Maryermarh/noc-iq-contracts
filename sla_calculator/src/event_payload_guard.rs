#![allow(clippy::assign_op_pattern)]

use soroban_sdk::{contracttype, symbol_short, Env, Map, String, Symbol};

pub const MAX_PAYLOAD_BYTES: u32 = 200;
pub const MAX_DESCRIPTION_BYTES: u32 = 128;
pub const MAX_METADATA_BYTES: u32 = 96;
pub const MAX_EVENT_FIELDS: u32 = 8;
pub const PAYLOAD_REJECTED: Symbol = symbol_short!("too_big");
pub const PAYLOAD_OK: Symbol = symbol_short!("pl_ok");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayloadError {
    DescriptionEmpty,
    DescriptionTooLarge,
    MetadataTooLarge,
    PayloadTooLarge,
    TooManyFields,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PayloadReport {
    pub description_bytes: u32,
    pub metadata_bytes: u32,
    pub total_bytes: u32,
    pub remaining_bytes: u32,
    pub within_limits: bool,
}

pub fn description_bytes(_env: &Env, description: &String) -> u32 {
    description.len()
}

pub fn metadata_bytes(_env: &Env, metadata: &String) -> u32 {
    metadata.len()
}

pub fn total_bytes(env: &Env, description: &String, metadata: &String) -> u32 {
    description_bytes(env, description) + metadata_bytes(env, metadata)
}

pub fn remaining_budget(env: &Env, description: &String, metadata: &String) -> u32 {
    MAX_PAYLOAD_BYTES.saturating_sub(total_bytes(env, description, metadata))
}

pub fn validate_description(env: &Env, description: &String) -> Result<u32, PayloadError> {
    let bytes = description_bytes(env, description);
    if bytes == 0 {
        return Err(PayloadError::DescriptionEmpty);
    }
    if bytes > MAX_DESCRIPTION_BYTES {
        return Err(PayloadError::DescriptionTooLarge);
    }
    Ok(bytes)
}

pub fn validate_metadata(env: &Env, metadata: &String) -> Result<u32, PayloadError> {
    let bytes = metadata_bytes(env, metadata);
    if bytes > MAX_METADATA_BYTES {
        return Err(PayloadError::MetadataTooLarge);
    }
    Ok(bytes)
}

pub fn validate_payload(
    env: &Env,
    description: &String,
    metadata: &String,
) -> Result<u32, PayloadError> {
    let description_size = validate_description(env, description)?;
    let metadata_size = validate_metadata(env, metadata)?;
    let total = description_size + metadata_size;
    if total > MAX_PAYLOAD_BYTES {
        return Err(PayloadError::PayloadTooLarge);
    }
    Ok(total)
}

pub fn validate_field_count(field_count: u32) -> Result<(), PayloadError> {
    if field_count > MAX_EVENT_FIELDS {
        return Err(PayloadError::TooManyFields);
    }
    Ok(())
}

pub fn inspect(env: &Env, description: &String, metadata: &String) -> PayloadReport {
    let description_size = description_bytes(env, description);
    let metadata_size = metadata_bytes(env, metadata);
    let total = description_size + metadata_size;
    let within_limits = total <= MAX_PAYLOAD_BYTES
        && description_size <= MAX_DESCRIPTION_BYTES
        && description_size > 0
        && metadata_size <= MAX_METADATA_BYTES;
    PayloadReport {
        description_bytes: description_size,
        metadata_bytes: metadata_size,
        total_bytes: total,
        remaining_bytes: remaining_budget(env, description, metadata),
        within_limits,
    }
}

pub fn fits(env: &Env, description: &String, metadata: &String) -> bool {
    inspect(env, description, metadata).within_limits
}

pub fn emit_rejection(env: &Env, outage_id: Symbol, error: PayloadError) {
    env.events()
        .publish((PAYLOAD_REJECTED, outage_id), error as u32);
}

pub fn emit_accepted(env: &Env, outage_id: Symbol, report: &PayloadReport) {
    env.events()
        .publish((PAYLOAD_OK, outage_id), report.total_bytes);
}

/// #1027 — storage key for byte sizes of accepted payloads, used as the
/// index that rejection must never touch.
const PAYLOAD_INDEX_KEY: Symbol = symbol_short!("ev_pidx");

/// Validate the serialized size *before* writing state, then publish the
/// acceptance event and update the index as one guarded operation.
///
/// A rejected payload produces no event and leaves the index untouched, so
/// off-chain consumers can never observe a partially committed transition.
pub fn emit_guarded(
    env: &Env,
    outage_id: Symbol,
    description: &String,
    metadata: &String,
) -> Result<PayloadReport, PayloadError> {
    let total = validate_payload(env, description, metadata)?;
    crate::event_schema::validate_serialized_payload_size(total)
        .map_err(|_| PayloadError::PayloadTooLarge)?;

    let report = inspect(env, description, metadata);
    env.events().publish((PAYLOAD_OK, outage_id.clone()), total);

    let mut index: Map<Symbol, u32> = env
        .storage()
        .instance()
        .get(&PAYLOAD_INDEX_KEY)
        .unwrap_or(Map::new(env));
    index.set(outage_id, total);
    env.storage().instance().set(&PAYLOAD_INDEX_KEY, &index);

    Ok(report)
}

/// Byte size recorded for `outage_id`, if an accepted payload was emitted.
pub fn indexed_payload_size(env: &Env, outage_id: &Symbol) -> Option<u32> {
    let index: Map<Symbol, u32> = env
        .storage()
        .instance()
        .get(&PAYLOAD_INDEX_KEY)
        .unwrap_or(Map::new(env));
    index.get(outage_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Events as _;

    fn text(env: &Env, literal: &str) -> String {
        String::from_str(env, literal)
    }

    fn repeat(env: &Env, literal: &str, times: u32) -> String {
        const ZEROS: [u8; 512] = [b'z'; 512];
        assert!((literal.len() * times as usize) <= ZEROS.len());
        let total = literal.len() * times as usize;
        let source = literal.as_bytes();
        let mut slice: [u8; 512] = ZEROS;
        for (position, slot) in slice.iter_mut().enumerate().take(total) {
            *slot = source[position % source.len()];
        }
        String::from_bytes(env, &slice[..total])
    }

    #[test]
    fn a_small_payload_is_accepted() {
        let env = Env::default();
        let description = text(&env, "gateway timeouts");
        let metadata = text(&env, "region=eu-west");
        assert_eq!(validate_payload(&env, &description, &metadata), Ok(30));
    }

    #[test]
    fn an_empty_description_is_rejected() {
        let env = Env::default();
        let description = text(&env, "");
        let metadata = text(&env, "region=eu-west");
        assert_eq!(
            validate_payload(&env, &description, &metadata),
            Err(PayloadError::DescriptionEmpty)
        );
    }

    #[test]
    fn an_oversized_description_is_rejected() {
        let env = Env::default();
        let description = repeat(&env, "a", MAX_DESCRIPTION_BYTES + 1);
        let metadata = text(&env, "ok");
        assert_eq!(
            validate_payload(&env, &description, &metadata),
            Err(PayloadError::DescriptionTooLarge)
        );
    }

    #[test]
    fn oversized_metadata_is_rejected() {
        let env = Env::default();
        let description = text(&env, "outage");
        let metadata = repeat(&env, "m", MAX_METADATA_BYTES + 1);
        assert_eq!(
            validate_payload(&env, &description, &metadata),
            Err(PayloadError::MetadataTooLarge)
        );
    }

    #[test]
    fn the_combined_budget_is_enforced() {
        let env = Env::default();
        let description = repeat(&env, "a", MAX_DESCRIPTION_BYTES);
        let metadata = repeat(&env, "m", MAX_METADATA_BYTES);
        assert_eq!(
            validate_payload(&env, &description, &metadata),
            Err(PayloadError::PayloadTooLarge)
        );
    }

    #[test]
    fn a_payload_exactly_on_the_limit_is_accepted() {
        let env = Env::default();
        let description = repeat(&env, "a", MAX_DESCRIPTION_BYTES);
        let metadata = repeat(&env, "m", MAX_PAYLOAD_BYTES - MAX_DESCRIPTION_BYTES);
        let report = inspect(&env, &description, &metadata);
        assert!(report.within_limits);
        assert_eq!(report.total_bytes, MAX_PAYLOAD_BYTES);
        assert_eq!(report.remaining_bytes, 0);
        assert_eq!(
            validate_payload(&env, &description, &metadata),
            Ok(MAX_PAYLOAD_BYTES)
        );
    }

    #[test]
    fn the_report_accounts_for_every_field() {
        let env = Env::default();
        let description = text(&env, "12345");
        let metadata = text(&env, "1234567890");
        let report = inspect(&env, &description, &metadata);
        assert_eq!(report.description_bytes, 5);
        assert_eq!(report.metadata_bytes, 10);
        assert_eq!(report.total_bytes, 15);
        assert_eq!(report.remaining_bytes, MAX_PAYLOAD_BYTES - 15);
    }

    #[test]
    fn the_report_flags_a_payload_that_does_not_fit() {
        let env = Env::default();
        let description = repeat(&env, "a", MAX_PAYLOAD_BYTES + 1);
        let metadata = text(&env, "");
        assert!(!fits(&env, &description, &metadata));
    }

    #[test]
    fn a_rejection_event_is_published() {
        let env = Env::default();
        let contract = env.register_contract(None, crate::SLACalculatorContract);
        env.as_contract(&contract, || {
            let outage = Symbol::new(&env, "OUT1");
            emit_rejection(&env, outage, PayloadError::PayloadTooLarge);
            assert_eq!(env.events().all().len(), 1);
        });
    }

    #[test]
    fn an_acceptance_event_is_published() {
        let env = Env::default();
        let contract = env.register_contract(None, crate::SLACalculatorContract);
        env.as_contract(&contract, || {
            let outage = Symbol::new(&env, "OUT1");
            let description = text(&env, "gateway");
            let metadata = text(&env, "eu");
            let report = inspect(&env, &description, &metadata);
            emit_accepted(&env, outage, &report);
            assert_eq!(env.events().all().len(), 1);
        });
    }

    #[test]
    fn over_limit_field_counts_are_rejected() {
        assert_eq!(validate_field_count(0), Ok(()));
        assert_eq!(validate_field_count(MAX_EVENT_FIELDS), Ok(()));
        assert_eq!(
            validate_field_count(MAX_EVENT_FIELDS + 1),
            Err(PayloadError::TooManyFields)
        );
    }
}

#[cfg(test)]
mod guarded_emit_tests {
    use super::*;
    use soroban_sdk::testutils::Events as _;

    fn repeat(env: &Env, byte: u8, times: u32) -> String {
        let mut buf = [0u8; 512];
        let total = times as usize;
        assert!(total <= buf.len());
        for slot in buf.iter_mut().take(total) {
            *slot = byte;
        }
        String::from_bytes(env, &buf[..total])
    }

    #[test]
    fn a_payload_on_the_limit_is_emitted_and_indexed() {
        let env = Env::default();
        let contract = env.register_contract(None, crate::SLACalculatorContract);
        env.as_contract(&contract, || {
            let outage = Symbol::new(&env, "OUT1");
            let description = repeat(&env, "a", MAX_DESCRIPTION_BYTES);
            let metadata = repeat(&env, "m", MAX_PAYLOAD_BYTES - MAX_DESCRIPTION_BYTES);

            let report = emit_guarded(&env, outage.clone(), &description, &metadata).unwrap();
            assert_eq!(report.total_bytes, MAX_PAYLOAD_BYTES);
            assert_eq!(indexed_payload_size(&env, &outage), Some(MAX_PAYLOAD_BYTES));
            assert_eq!(env.events().all().len(), 1);
        });
    }

    #[test]
    fn one_byte_over_the_limit_emits_nothing_and_does_not_update_the_index() {
        let env = Env::default();
        let contract = env.register_contract(None, crate::SLACalculatorContract);
        env.as_contract(&contract, || {
            let outage = Symbol::new(&env, "OUT1");
            let description = repeat(&env, "a", MAX_DESCRIPTION_BYTES);
            let metadata = repeat(&env, "m", MAX_PAYLOAD_BYTES - MAX_DESCRIPTION_BYTES + 1);

            assert_eq!(
                emit_guarded(&env, outage.clone(), &description, &metadata),
                Err(PayloadError::PayloadTooLarge)
            );
            assert_eq!(indexed_payload_size(&env, &outage), None);
            assert_eq!(env.events().all().len(), 0);
        });
    }
}
