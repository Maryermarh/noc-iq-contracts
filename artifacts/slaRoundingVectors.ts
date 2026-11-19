/**
 * Contract parity vectors for SLA amount rounding (issues #1065, #1049).
 *
 * Every expected value was derived by hand from `compute_result` in
 * `sla_calculator/src/lib.rs` and is documented in `docs/SLA_SPEC.md`
 * ("Rounding and evaluation order"):
 *
 *   penalty = (mttr - threshold) * penalty_per_minute            (exact, no rounding)
 *   ratio   = floor(mttr * 100 / threshold)                      (tier selector)
 *   reward  = floor(reward_base * tier_multiplier / 100)         (multiply first, then floor)
 *
 * Amounts are signed integers in the contract's smallest unit: penalties are negative.
 */

export interface SlaConfigVector {
  threshold_minutes: number;
  penalty_per_minute: number;
  reward_base: number;
  top_tier_multiplier: number;
  excel_tier_multiplier: number;
  good_tier_multiplier: number;
}

export interface RoundingVector {
  label: string;
  config: SlaConfigVector;
  mttr_minutes: number;
  expected: {
    status: "met" | "viol";
    payment_type: "rew" | "pen";
    rating: "top" | "excel" | "good" | "poor";
    amount: number;
  };
}

/** Default `critical` configuration shipped by `initialize_default_configs`. */
export const CRITICAL: SlaConfigVector = {
  threshold_minutes: 15,
  penalty_per_minute: 100,
  reward_base: 750,
  top_tier_multiplier: 200,
  excel_tier_multiplier: 150,
  good_tier_multiplier: 100,
};

/** Default `medium` configuration. */
export const MEDIUM: SlaConfigVector = {
  threshold_minutes: 60,
  penalty_per_minute: 20,
  reward_base: 250,
  top_tier_multiplier: 200,
  excel_tier_multiplier: 150,
  good_tier_multiplier: 100,
};

/** A configuration whose reward does not divide evenly, to pin the floor. */
export const ODD_BASE: SlaConfigVector = {
  threshold_minutes: 60,
  penalty_per_minute: 20,
  reward_base: 101,
  top_tier_multiplier: 200,
  excel_tier_multiplier: 150,
  good_tier_multiplier: 100,
};

export const ROUNDING_VECTORS: RoundingVector[] = [
  { label: "mttr 0 is an instant resolution: zero reward, top rating", config: CRITICAL, mttr_minutes: 0,
    expected: { status: "met", payment_type: "rew", rating: "top", amount: 0 } },
  { label: "ratio 46 (<50) -> top tier: 750*200/100", config: CRITICAL, mttr_minutes: 7,
    expected: { status: "met", payment_type: "rew", rating: "top", amount: 1500 } },
  { label: "ratio 53 (>=50) -> excel tier: 750*150/100 = 1125", config: CRITICAL, mttr_minutes: 8,
    expected: { status: "met", payment_type: "rew", rating: "excel", amount: 1125 } },
  { label: "ratio 73 (<75) -> excel tier", config: CRITICAL, mttr_minutes: 11,
    expected: { status: "met", payment_type: "rew", rating: "excel", amount: 1125 } },
  { label: "ratio 80 (>=75) -> good tier: 750*100/100", config: CRITICAL, mttr_minutes: 12,
    expected: { status: "met", payment_type: "rew", rating: "good", amount: 750 } },
  { label: "mttr == threshold is still met (ratio 100, good tier)", config: CRITICAL, mttr_minutes: 15,
    expected: { status: "met", payment_type: "rew", rating: "good", amount: 750 } },
  { label: "one minute over: penalty is exactly 1*100, negative", config: CRITICAL, mttr_minutes: 16,
    expected: { status: "viol", payment_type: "pen", rating: "poor", amount: -100 } },
  { label: "45 minutes over: (60-15)*100", config: CRITICAL, mttr_minutes: 60,
    expected: { status: "viol", payment_type: "pen", rating: "poor", amount: -4500 } },
  { label: "ratio exactly 50 is excel, not top (medium, mttr 30)", config: MEDIUM, mttr_minutes: 30,
    expected: { status: "met", payment_type: "rew", rating: "excel", amount: 375 } },
  { label: "ratio 48 is top (medium, mttr 29)", config: MEDIUM, mttr_minutes: 29,
    expected: { status: "met", payment_type: "rew", rating: "top", amount: 500 } },
  { label: "ratio exactly 75 is good, not excel (medium, mttr 45)", config: MEDIUM, mttr_minutes: 45,
    expected: { status: "met", payment_type: "rew", rating: "good", amount: 250 } },
  { label: "fractional reward floors: 101*150/100 = 151.5 -> 151", config: ODD_BASE, mttr_minutes: 40,
    expected: { status: "met", payment_type: "rew", rating: "excel", amount: 151 } },
  { label: "good tier on an odd base is exact: 101*100/100", config: ODD_BASE, mttr_minutes: 50,
    expected: { status: "met", payment_type: "rew", rating: "good", amount: 101 } },
];
