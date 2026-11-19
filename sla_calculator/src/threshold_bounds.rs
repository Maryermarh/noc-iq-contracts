use soroban_sdk::Env;

pub const MIN_THRESHOLD_MINUTES: u32 = 1;
pub const MAX_THRESHOLD_MINUTES: u32 = 1440;

#[derive(Debug, Clone, PartialEq)]
pub enum ThresholdValidationError {
    ThresholdOutOfBounds,
}

/// Validates that `threshold_minutes` stays within the 24-hour SLA cap.
pub fn validate_threshold_minutes(
    _env: &Env,
    threshold_minutes: u32,
) -> Result<(), ThresholdValidationError> {
    if threshold_minutes < MIN_THRESHOLD_MINUTES
        || threshold_minutes > MAX_THRESHOLD_MINUTES
    {
        return Err(ThresholdValidationError::ThresholdOutOfBounds);
    }
    Ok(())
}

/// #1017 — a threshold as it was configured and as it will actually be used.
/// Keeping both values visible makes it explicit when a safety bound clamps
/// the stored configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveThreshold {
    pub configured_minutes: u32,
    pub effective_minutes: u32,
    pub clamped: bool,
}

/// Resolve the effective threshold, clamping into `[MIN, MAX]` while always
/// reporting the originally configured value alongside it.
pub fn resolve_effective_threshold(
    threshold_minutes: u32,
) -> Result<EffectiveThreshold, ThresholdValidationError> {
    if threshold_minutes < MIN_THRESHOLD_MINUTES {
        return Ok(EffectiveThreshold {
            configured_minutes: threshold_minutes,
            effective_minutes: MIN_THRESHOLD_MINUTES,
            clamped: true,
        });
    }
    if threshold_minutes > MAX_THRESHOLD_MINUTES {
        return Ok(EffectiveThreshold {
            configured_minutes: threshold_minutes,
            effective_minutes: MAX_THRESHOLD_MINUTES,
            clamped: true,
        });
    }
    Ok(EffectiveThreshold {
        configured_minutes: threshold_minutes,
        effective_minutes: threshold_minutes,
        clamped: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_minimum_and_maximum_are_accepted() {
        let env = Env::default();
        assert_eq!(validate_threshold_minutes(&env, MIN_THRESHOLD_MINUTES), Ok(()));
        assert_eq!(validate_threshold_minutes(&env, MAX_THRESHOLD_MINUTES), Ok(()));
    }

    #[test]
    fn test_below_minimum_is_rejected() {
        let env = Env::default();
        assert_eq!(
            validate_threshold_minutes(&env, MIN_THRESHOLD_MINUTES - 1),
            Err(ThresholdValidationError::ThresholdOutOfBounds)
        );
    }

    #[test]
    fn test_above_maximum_is_rejected() {
        let env = Env::default();
        assert_eq!(
            validate_threshold_minutes(&env, MAX_THRESHOLD_MINUTES + 1),
            Err(ThresholdValidationError::ThresholdOutOfBounds)
        );
        assert_eq!(
            validate_threshold_minutes(&env, u32::MAX),
            Err(ThresholdValidationError::ThresholdOutOfBounds)
        );
    }

    #[test]
    fn test_bounds_span_a_full_day() {
        assert_eq!(MAX_THRESHOLD_MINUTES, 24 * 60);
        assert!(MIN_THRESHOLD_MINUTES < MAX_THRESHOLD_MINUTES);
    }
}

#[cfg(test)]
mod effective_threshold_tests {
    use super::*;

    #[test]
    fn a_value_below_the_range_is_reported_as_clamped() {
        let resolved = resolve_effective_threshold(MIN_THRESHOLD_MINUTES - 1).unwrap();
        assert_eq!(resolved.configured_minutes, MIN_THRESHOLD_MINUTES - 1);
        assert_eq!(resolved.effective_minutes, MIN_THRESHOLD_MINUTES);
        assert!(resolved.clamped);
    }

    #[test]
    fn a_value_within_the_range_is_reported_unchanged() {
        let resolved = resolve_effective_threshold(60).unwrap();
        assert_eq!(resolved.configured_minutes, 60);
        assert_eq!(resolved.effective_minutes, 60);
        assert!(!resolved.clamped);
    }

    #[test]
    fn a_value_above_the_range_is_reported_as_clamped() {
        let resolved = resolve_effective_threshold(MAX_THRESHOLD_MINUTES + 1).unwrap();
        assert_eq!(resolved.configured_minutes, MAX_THRESHOLD_MINUTES + 1);
        assert_eq!(resolved.effective_minutes, MAX_THRESHOLD_MINUTES);
        assert!(resolved.clamped);
    }
}
