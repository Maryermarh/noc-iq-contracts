/**
 * SC-W5-110: End-to-end SLA->payment intent integration conformance suite.
 *
 * Validates that SLA calculation results deterministically map to the correct
 * payment intent shape expected by the backend. Covers met/violated paths,
 * reward tiers, penalty amounts, and negative/adversarial cases.
 */

import { ROUNDING_VECTORS } from "../artifacts/slaRoundingVectors";
import type { SlaConfigVector, RoundingVector } from "../artifacts/slaRoundingVectors";

export interface SlaResult {
  status: "met" | "viol";
  payment_type: "rew" | "pen";
  rating: "top" | "excel" | "good" | "poor";
  amount: number;
  config_version_hash: string;
}

export interface PaymentIntent {
  outage_id: string;
  payment_type: "rew" | "pen";
  amount: number;
  rating: string;
  sla_met: boolean;
}

/**
 * Contract amounts are whole numbers in the smallest unit (i128 on chain). An off-chain amount
 * with a fractional part, an exponent, a non-finite value, or more than 2^53 of magnitude cannot
 * be reproduced exactly, so it is rejected instead of being rounded to something else.
 */
export function assertSupportedPrecision(amount: number | string): number {
  if (typeof amount === "string") {
    if (!/^-?\d+$/.test(amount)) {
      throw new Error(`[SC-W5-110] Unsupported precision: ${JSON.stringify(amount)} is not a whole number`);
    }
    const n = Number(amount);
    if (!Number.isSafeInteger(n)) throw new Error(`[SC-W5-110] Unsupported precision: ${amount} exceeds 2^53`);
    return n;
  }
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`[SC-W5-110] Unsupported precision: ${amount} is not a safe whole number`);
  }
  return amount;
}

/**
 * Reference implementation of the contract's `compute_result` rounding, using BigInt so the
 * multiply-then-floor order is exact. Used to check the intent amounts against parity vectors.
 */
export function computeContractResult(
  cfg: SlaConfigVector,
  mttr_minutes: number
): RoundingVector["expected"] {
  const T = BigInt(cfg.threshold_minutes);
  const M = BigInt(mttr_minutes);
  if (M === 0n) return { status: "met", payment_type: "rew", rating: "top", amount: 0 };
  if (M > T) {
    const penalty = (M - T) * BigInt(cfg.penalty_per_minute);
    return { status: "viol", payment_type: "pen", rating: "poor", amount: Number(-penalty) };
  }
  const ratio = (M * 100n) / T; // both non-negative: truncation == floor
  const [multiplier, rating] =
    ratio < 50n ? [cfg.top_tier_multiplier, "top" as const]
    : ratio < 75n ? [cfg.excel_tier_multiplier, "excel" as const]
    : [cfg.good_tier_multiplier, "good" as const];
  const reward = (BigInt(cfg.reward_base) * BigInt(multiplier)) / 100n;
  return { status: "met", payment_type: "rew", rating, amount: Number(reward) };
}

/** Map an SLA result to the payment intent the backend must enqueue. */
export function buildPaymentIntent(
  outage_id: string,
  result: SlaResult
): PaymentIntent {
  // Unsupported precision must fail before any payout transaction is built from the intent.
  assertSupportedPrecision(result.amount);
  return {
    outage_id,
    payment_type: result.payment_type,
    amount: result.amount,
    rating: result.rating,
    sla_met: result.status === "met",
  };
}

interface ConformanceCase {
  label: string;
  outage_id: string;
  result: SlaResult;
  expected: Partial<PaymentIntent>;
}

const cases: ConformanceCase[] = [
  {
    label: "critical met -> reward top",
    outage_id: "OUT001",
    result: { status: "met", payment_type: "rew", rating: "top", amount: 500, config_version_hash: "abc" },
    expected: { payment_type: "rew", sla_met: true, rating: "top", amount: 500 },
  },
  {
    label: "critical violated -> penalty",
    outage_id: "OUT002",
    result: { status: "viol", payment_type: "pen", rating: "poor", amount: 1000, config_version_hash: "abc" },
    expected: { payment_type: "pen", sla_met: false, rating: "poor", amount: 1000 },
  },
  {
    label: "high met -> reward good",
    outage_id: "OUT003",
    result: { status: "met", payment_type: "rew", rating: "good", amount: 200, config_version_hash: "abc" },
    expected: { payment_type: "rew", sla_met: true, rating: "good" },
  },
  {
    label: "zero-amount reward is valid",
    outage_id: "OUT004",
    result: { status: "met", payment_type: "rew", rating: "good", amount: 0, config_version_hash: "abc" },
    expected: { payment_type: "rew", sla_met: true, amount: 0 },
  },
];

// Adversarial: negative amount must be rejected
function assertNoNegativeAmount(result: SlaResult): void {
  if (result.amount < 0) throw new Error(`[SC-W5-110] Negative payment amount: ${result.amount}`);
}

// Adversarial: payment_type must match status
function assertTypeMatchesStatus(result: SlaResult): void {
  if (result.status === "met" && result.payment_type !== "rew")
    throw new Error(`[SC-W5-110] status=met but payment_type=${result.payment_type}`);
  if (result.status === "viol" && result.payment_type !== "pen")
    throw new Error(`[SC-W5-110] status=viol but payment_type=${result.payment_type}`);
}

function runConformance(): void {
  console.log("[SC-W5-110] SLA->payment intent conformance suite\n");
  let passed = 0;
  for (const c of cases) {
    assertNoNegativeAmount(c.result);
    assertTypeMatchesStatus(c.result);
    const intent = buildPaymentIntent(c.outage_id, c.result);
    for (const [k, v] of Object.entries(c.expected)) {
      if ((intent as any)[k] !== v)
        throw new Error(`[SC-W5-110] "${c.label}": ${k} expected ${v}, got ${(intent as any)[k]}`);
    }
    console.log(`  ✓ ${c.label}`);
    passed++;
  }

  // Adversarial: mismatch between status and type must be caught
  try {
    assertTypeMatchesStatus({ status: "met", payment_type: "pen", rating: "good", amount: 0, config_version_hash: "" });
    throw new Error("Should have thrown");
  } catch (e: any) {
    if (!e.message.includes("SC-W5-110")) throw e;
    console.log("  ✓ adversarial: met+pen rejected");
  }

  // Boundary amounts must match the checked-in contract parity vectors.
  for (const v of ROUNDING_VECTORS) {
    const computed = computeContractResult(v.config, v.mttr_minutes);
    for (const k of Object.keys(v.expected) as Array<keyof RoundingVector["expected"]>) {
      if (computed[k] !== v.expected[k])
        throw new Error(`[SC-W5-110] vector "${v.label}": ${k} expected ${v.expected[k]}, got ${computed[k]}`);
    }
    console.log(`  ✓ parity vector: ${v.label}`);
    passed++;
  }

  // Intents built from magnitudes of the vector amounts keep the exact integer.
  for (const v of ROUNDING_VECTORS.filter((x) => x.expected.payment_type === "rew")) {
    const intent = buildPaymentIntent("OUTV", {
      status: v.expected.status,
      payment_type: v.expected.payment_type,
      rating: v.expected.rating as SlaResult["rating"],
      amount: v.expected.amount,
      config_version_hash: "abc",
    });
    if (intent.amount !== v.expected.amount) throw new Error(`[SC-W5-110] intent amount drift for "${v.label}"`);
  }
  console.log("  ✓ reward intents carry the exact contract amounts");

  // Adversarial: unsupported precision fails before an intent is built.
  const unsupported: Array<number | string> = [1.5, 0.1 + 0.2, NaN, Infinity, 2 ** 53, "1.5", "1e3", "0x10", ""];
  for (const amount of unsupported) {
    try {
      buildPaymentIntent("OUTP", {
        status: "met", payment_type: "rew", rating: "good", amount: amount as number, config_version_hash: "abc",
      });
      throw new Error(`Should have thrown for ${String(amount)}`);
    } catch (e: any) {
      if (!e.message.includes("Unsupported precision")) throw e;
    }
  }
  console.log("  ✓ adversarial: fractional, non-finite, exponent and >2^53 amounts rejected");

  console.log(`\n${passed} conformance cases + adversarial checks passed.`);
}

runConformance();
