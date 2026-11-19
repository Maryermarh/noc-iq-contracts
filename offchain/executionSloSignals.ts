export type SloStatus = "healthy" | "degraded" | "breached";

export interface ExecutionSloSignal {
  contractId: string;
  method: string;
  /** Failure kind for the call, when it failed. Only allowlisted values are ever used as a label. */
  failure?: string;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errorRate: number;
}

export interface SloThresholds { p95WarnMs: number; p99BreachMs: number; errorRateWarn: number; }

const defaultThresholds: SloThresholds = { p95WarnMs: 500, p99BreachMs: 2_000, errorRateWarn: 0.01 };

export function evaluateSlo(signal: ExecutionSloSignal, t = defaultThresholds): SloStatus {
  if (signal.p99Ms > t.p99BreachMs || signal.errorRate > t.errorRateWarn * 5) return "breached";
  if (signal.p95Ms > t.p95WarnMs   || signal.errorRate > t.errorRateWarn)     return "degraded";
  return "healthy";
}

export function printSloReport(signals: ExecutionSloSignal[]): void {
  for (const s of signals) {
    const status = evaluateSlo(s);
    console.log(`  [${status.toUpperCase().padEnd(8)}] ${s.contractId}::${s.method}  p95=${s.p95Ms}ms p99=${s.p99Ms}ms errRate=${(s.errorRate * 100).toFixed(2)}%`);
  }
}

// ---------------------------------------------------------------------------
// #1058: bounded metric labels
// ---------------------------------------------------------------------------

/** Routes (contract methods) allowed as a metric label. Anything else is reported as `other`. */
export const ALLOWED_ROUTES = [
  "calculate_sla", "batch_calculate", "calculate_sla_view", "simulate_sla",
  "get_config", "set_config", "list_configs",
  "get_history", "get_history_page", "get_stats",
  "pause", "unpause", "is_paused", "get_admin", "get_operator",
] as const;

/** Failure kinds allowed as a metric label. */
export const ALLOWED_FAILURES = [
  "none", "timeout", "rpc_error", "contract_error", "unauthorized", "paused", "invalid_input",
] as const;

export type MetricRoute = (typeof ALLOWED_ROUTES)[number] | "other";
export type MetricFailure = (typeof ALLOWED_FAILURES)[number] | "other";

export interface SloMetricLabels {
  route: MetricRoute;
  failure: MetricFailure;
  status: SloStatus;
}

function allowlisted<T extends string>(value: string | undefined, allowed: readonly T[]): T | "other" {
  const v = (value ?? "").trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : "other";
}

/**
 * Builds the label set for an SLO metric. Route and failure are normalized to fixed allowlists
 * (anything unrecognized, including transaction hashes, contract IDs and free-form error text,
 * collapses to `other`), and the contract ID is never a label. The number of distinct label
 * combinations is therefore bounded.
 */
export function buildMetricLabels(signal: ExecutionSloSignal, t = defaultThresholds): SloMetricLabels {
  return {
    route: allowlisted(signal.method, ALLOWED_ROUTES),
    failure: signal.failure === undefined ? "none" : allowlisted(signal.failure, ALLOWED_FAILURES),
    status: evaluateSlo(signal, t),
  };
}

/** Upper bound on distinct label combinations a metric built from {@link buildMetricLabels} can have. */
export const MAX_LABEL_COMBINATIONS = (ALLOWED_ROUTES.length + 1) * (ALLOWED_FAILURES.length + 1) * 3;
