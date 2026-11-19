use soroban_sdk::{symbol_short, Address, Env, Symbol};

use crate::{SLAError, SLAStats, ADMIN_KEY, STATS_KEY};

// -----------------------------------------------------------------------
// Storage keys
// -----------------------------------------------------------------------
const TUNING_KEY: Symbol = symbol_short!("TUNE");

// -----------------------------------------------------------------------
// #820 — bounds for the computed adjustment factor
// -----------------------------------------------------------------------
/// Documented lower bound of the adaptive adjustment factor, in basis points.
pub const MIN_ADJUSTMENT_FACTOR_BPS: i32 = -5_000;
/// Documented upper bound of the adaptive adjustment factor, in basis points.
pub const MAX_ADJUSTMENT_FACTOR_BPS: i32 = 5_000;

/// Clamp a computed adjustment factor into the documented, reviewable range.
pub fn clamp_adjustment_factor(factor: i32) -> i32 {
    factor.clamp(MIN_ADJUSTMENT_FACTOR_BPS, MAX_ADJUSTMENT_FACTOR_BPS)
}

/// Reject tuning configuration that could produce an unbounded adjustment.
pub fn validate_tuning_config(config: &TuningConfig) -> Result<(), SLAError> {
    if config.target_compliance_bps > 10_000 {
        return Err(SLAError::InvalidThreshold);
    }
    if config.adjustment_step_bps == 0 || config.adjustment_step_bps > config.max_adjustment_bps {
        return Err(SLAError::InvalidThreshold);
    }
    if (config.max_adjustment_bps as i32) > MAX_ADJUSTMENT_FACTOR_BPS {
        return Err(SLAError::InvalidThreshold);
    }
    Ok(())
}

// -----------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------
const EVENT_TUNE_SET: Symbol = symbol_short!("tune_set");
const EVENT_TUNE_APPLY: Symbol = symbol_short!("tune_ap");
const EVENT_VERSION: Symbol = symbol_short!("v1");

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

/// Adaptive tuning configuration.
#[soroban_sdk::contracttype]
pub struct TuningConfig {
    /// Target compliance rate (basis points, e.g., 9500 = 95%).
    pub target_compliance_bps: u32,
    /// Adjustment step size (basis points).
    pub adjustment_step_bps: u32,
    /// Maximum adjustment per period.
    pub max_adjustment_bps: u32,
    /// Evaluation window in seconds.
    pub evaluation_window: u64,
    /// Whether adaptive tuning is enabled.
    pub enabled: bool,
}

/// Tuning recommendation.
#[soroban_sdk::contracttype]
pub struct TuningRecommendation {
    /// Current compliance rate.
    pub current_compliance_bps: u32,
    /// Target compliance rate.
    pub target_compliance_bps: u32,
    /// Gap to target.
    pub gap_bps: i32,
    /// Recommended threshold adjustment.
    pub threshold_adjustment: i32,
    /// Recommended penalty adjustment.
    pub penalty_adjustment: i32,
    /// Whether adjustment is recommended.
    pub should_adjust: bool,
}

// -----------------------------------------------------------------------
// Functions
// -----------------------------------------------------------------------

/// Initialize adaptive tuning as disabled.
pub fn init_tuning(env: &Env) {
    env.storage().instance().set(
        &TUNING_KEY,
        &TuningConfig {
            target_compliance_bps: 9500,
            adjustment_step_bps: 100,
            max_adjustment_bps: 500,
            evaluation_window: 86400,
            enabled: false,
        },
    );
}

/// Configure adaptive tuning (admin only).
pub fn set_tuning(
    env: &Env,
    caller: &Address,
    target_compliance_bps: u32,
    adjustment_step_bps: u32,
    max_adjustment_bps: u32,
    evaluation_window: u64,
) -> Result<(), SLAError> {
    require_admin(env, caller)?;

    let config = TuningConfig {
        target_compliance_bps,
        adjustment_step_bps,
        max_adjustment_bps,
        evaluation_window,
        enabled: true,
    };
    validate_tuning_config(&config)?;

    env.storage().instance().set(&TUNING_KEY, &config);

    env.events().publish(
        (EVENT_TUNE_SET, EVENT_VERSION, caller),
        (target_compliance_bps, adjustment_step_bps),
    );

    Ok(())
}

/// Disable adaptive tuning (admin only).
pub fn disable_tuning(env: &Env, caller: &Address) -> Result<(), SLAError> {
    require_admin(env, caller)?;

    let mut config: TuningConfig =
        env.storage()
            .instance()
            .get(&TUNING_KEY)
            .unwrap_or(TuningConfig {
                target_compliance_bps: 9500,
                adjustment_step_bps: 100,
                max_adjustment_bps: 500,
                evaluation_window: 86400,
                enabled: false,
            });

    config.enabled = false;
    env.storage().instance().set(&TUNING_KEY, &config);

    Ok(())
}

/// Generate tuning recommendation based on current stats.
pub fn get_tuning_recommendation(env: &Env) -> Result<TuningRecommendation, SLAError> {
    let config: TuningConfig = env
        .storage()
        .instance()
        .get(&TUNING_KEY)
        .unwrap_or(TuningConfig {
            target_compliance_bps: 9500,
            adjustment_step_bps: 100,
            max_adjustment_bps: 500,
            evaluation_window: 86400,
            enabled: false,
        });

    let stats: SLAStats = env
        .storage()
        .instance()
        .get(&STATS_KEY)
        .unwrap_or(SLAStats {
            total_calculations: 0,
            total_violations: 0,
            total_rewards: 0,
            total_penalties: 0,
        });

    // Calculate current compliance rate
    let current_compliance_bps = if stats.total_calculations > 0 {
        let met_count = stats.total_calculations - stats.total_violations;
        ((met_count * 10000) / stats.total_calculations) as u32
    } else {
        0
    };

    let gap_bps = config.target_compliance_bps as i32 - current_compliance_bps as i32;

    // Determine adjustments
    let should_adjust = config.enabled && gap_bps.unsigned_abs() > config.adjustment_step_bps;
    let mut threshold_adjustment: i32 = 0;
    let mut penalty_adjustment: i32 = 0;

    if should_adjust {
        if gap_bps > 0 {
            // Below target: loosen thresholds or increase penalties
            threshold_adjustment = config.adjustment_step_bps as i32;
            penalty_adjustment = -(config.adjustment_step_bps as i32);
        } else {
            // Above target: tighten thresholds or decrease penalties
            threshold_adjustment = -(config.adjustment_step_bps as i32);
            penalty_adjustment = config.adjustment_step_bps as i32;
        }

        // #820 — cap adjustments to the configured bound and then to the
        // documented absolute factor range, so extreme history can never
        // push a recommendation outside a sane, reviewable interval.
        threshold_adjustment = clamp_adjustment_factor(threshold_adjustment)
            .max(-(config.max_adjustment_bps as i32))
            .min(config.max_adjustment_bps as i32);
        penalty_adjustment = clamp_adjustment_factor(penalty_adjustment)
            .max(-(config.max_adjustment_bps as i32))
            .min(config.max_adjustment_bps as i32);
    }

    Ok(TuningRecommendation {
        current_compliance_bps,
        target_compliance_bps: config.target_compliance_bps,
        gap_bps,
        threshold_adjustment,
        penalty_adjustment,
        should_adjust,
    })
}

/// Get the tuning configuration.
pub fn get_tuning_config(env: &Env) -> Result<TuningConfig, SLAError> {
    Ok(env
        .storage()
        .instance()
        .get(&TUNING_KEY)
        .unwrap_or(TuningConfig {
            target_compliance_bps: 9500,
            adjustment_step_bps: 100,
            max_adjustment_bps: 500,
            evaluation_window: 86400,
            enabled: false,
        }))
}

/// Record that tuning was applied.
pub fn record_tuning_application(
    env: &Env,
    caller: &Address,
    threshold_adjustment: i32,
    penalty_adjustment: i32,
) {
    env.events().publish(
        (EVENT_TUNE_APPLY, EVENT_VERSION, caller),
        (threshold_adjustment, penalty_adjustment),
    );
}

/// Helper to verify admin role.
fn require_admin(env: &Env, caller: &Address) -> Result<(), SLAError> {
    let admin: Address = env
        .storage()
        .instance()
        .get(&ADMIN_KEY)
        .ok_or(SLAError::NotInitialized)?;
    if *caller != admin {
        return Err(SLAError::Unauthorized);
    }
    Ok(())
}

#[cfg(test)]
mod adjustment_factor_tests {
    use super::*;

    fn config(step: u32, max: u32) -> TuningConfig {
        TuningConfig {
            target_compliance_bps: 9_500,
            adjustment_step_bps: step,
            max_adjustment_bps: max,
            evaluation_window: 86_400,
            enabled: true,
        }
    }

    #[test]
    fn extreme_factors_are_clamped_to_the_documented_range() {
        assert_eq!(clamp_adjustment_factor(i32::MAX), MAX_ADJUSTMENT_FACTOR_BPS);
        assert_eq!(clamp_adjustment_factor(i32::MIN), MIN_ADJUSTMENT_FACTOR_BPS);
        assert_eq!(clamp_adjustment_factor(0), 0);
        assert_eq!(clamp_adjustment_factor(250), 250);
    }

    #[test]
    fn configuration_with_inverted_bounds_is_rejected() {
        assert_eq!(validate_tuning_config(&config(600, 500)), Err(SLAError::InvalidThreshold));
        assert_eq!(validate_tuning_config(&config(0, 500)), Err(SLAError::InvalidThreshold));
    }

    #[test]
    fn configuration_outside_the_factor_range_is_rejected() {
        assert_eq!(
            validate_tuning_config(&config(100, MAX_ADJUSTMENT_FACTOR_BPS as u32 + 1)),
            Err(SLAError::InvalidThreshold)
        );
        assert_eq!(validate_tuning_config(&config(100, 500)), Ok(()));
    }
}
