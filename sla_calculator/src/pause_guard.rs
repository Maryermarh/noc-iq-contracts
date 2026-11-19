use soroban_sdk::{symbol_short, Env, Symbol};

const PAUSED_KEY: Symbol = symbol_short!("PAUSED");

// Which exported entrypoints must call this guard is tracked in `scripts/pause-guard-inventory.json`
// and checked in CI by `scripts/check-pause-guard-inventory.ts`: a newly exported method that is
// not listed there fails the build with its name.
#[derive(Debug, Clone, PartialEq)]
pub enum GuardError {
    ContractPaused,
}

/// Call at the top of every state-mutating entry point to block execution
/// while the contract is paused.
pub fn require_not_paused(env: &Env) -> Result<(), GuardError> {
    let paused: bool = env.storage().instance().get(&PAUSED_KEY).unwrap_or(false);
    if paused {
        return Err(GuardError::ContractPaused);
    }
    Ok(())
}
