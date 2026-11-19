/**
 * SC-W5-114: Ambiguous outcome replay workflow for backend reconciliation.
 *
 * When the backend cannot determine whether a contract call succeeded
 * (network timeout, connection drop after submission), it must replay
 * through a structured reconciliation workflow before retrying.
 * This prevents double-application of SLA calculations.
 */

export type OutcomeVerdict = "confirmed" | "not_applied" | "indeterminate";

export interface ReconciliationQuery {
  outage_id: string;
  expected_ledger_min?: number; // earliest ledger the tx could have landed
  expected_ledger_max?: number; // latest ledger within sequence window
}

export interface ReconciliationResult {
  outage_id: string;
  verdict: OutcomeVerdict;
  found_in_history: boolean;
  safe_to_retry: boolean;
  action: "no_op" | "retry" | "escalate";
}

/**
 * Simulates querying contract history to reconcile ambiguous outcomes.
 * In production, `queryContractHistory` calls get_history on the contract.
 */
export function reconcile(
  query: ReconciliationQuery,
  historyIds: string[] // outage IDs found in contract history
): ReconciliationResult {
  const found = historyIds.includes(query.outage_id);

  if (found) {
    return {
      outage_id: query.outage_id,
      verdict: "confirmed",
      found_in_history: true,
      safe_to_retry: false,
      action: "no_op",
    };
  }

  // Not found in history — check if ledger window has passed
  const windowClosed =
    query.expected_ledger_max !== undefined &&
    query.expected_ledger_min !== undefined;

  if (windowClosed) {
    return {
      outage_id: query.outage_id,
      verdict: "not_applied",
      found_in_history: false,
      safe_to_retry: true,
      action: "retry",
    };
  }

  // Window not specified — cannot determine yet
  return {
    outage_id: query.outage_id,
    verdict: "indeterminate",
    found_in_history: false,
    safe_to_retry: false,
    action: "escalate",
  };
}

// ---------------------------------------------------------------------------
// #1052: submitted-but-unconfirmed is not the same as rejected
// ---------------------------------------------------------------------------

/** What the backend currently knows about a submission, with unconfirmed kept apart from rejected. */
export type ReplayOutcome =
  | "finalized"             // a lookup found the transaction applied
  | "rejected"              // definitively not applied: refused before submission, or failed on chain
  | "submitted_unconfirmed" // the network accepted it (or a lookup found nothing yet); it may still land
  | "unknown";              // the submit call itself was ambiguous (timeout, dropped connection)

export interface ReplayObservation {
  outage_id: string;
  /** What the submit call returned. */
  submit_result: "accepted" | "rejected" | "timeout" | "connection_lost";
  /** The result of a transaction lookup, once one has been done. */
  lookup?: "confirmed" | "failed" | "not_found";
}

export interface ReplayDecision {
  outage_id: string;
  outcome: ReplayOutcome;
  /** A lookup by transaction hash is still required before any resubmission decision. */
  requires_lookup: boolean;
  /** Only true for outcomes that are definitively not applied. */
  may_resubmit: boolean;
  reason: string;
}

/**
 * Decides what the replay tooling may do next. An outcome that is not definitively "rejected" or
 * "finalized" never allows resubmission, and an ambiguous one requires a lookup first, so a
 * timeout after submission is never treated as a safe-to-resubmit failure.
 */
export function decideReplay(obs: ReplayObservation): ReplayDecision {
  const base = { outage_id: obs.outage_id };

  if (obs.lookup === "confirmed") {
    return { ...base, outcome: "finalized", requires_lookup: false, may_resubmit: false, reason: "lookup found the transaction applied" };
  }
  if (obs.lookup === "failed") {
    return { ...base, outcome: "rejected", requires_lookup: false, may_resubmit: true, reason: "transaction failed on chain; it was not applied" };
  }
  if (obs.lookup === "not_found") {
    return {
      ...base,
      outcome: "submitted_unconfirmed",
      requires_lookup: false,
      may_resubmit: false,
      reason: "lookup found nothing yet; the transaction may still be included until its validity window closes",
    };
  }

  // No lookup has been done yet.
  switch (obs.submit_result) {
    case "rejected":
      return { ...base, outcome: "rejected", requires_lookup: false, may_resubmit: true, reason: "the network refused the submission; nothing was applied" };
    case "accepted":
      return { ...base, outcome: "submitted_unconfirmed", requires_lookup: true, may_resubmit: false, reason: "accepted but not yet confirmed; look it up before deciding" };
    case "timeout":
    case "connection_lost":
      return { ...base, outcome: "unknown", requires_lookup: true, may_resubmit: false, reason: `${obs.submit_result}: the transaction may have landed; look it up before deciding` };
  }
}

function runReplayDecisionTests(): void {
  console.log("\n[#1052] Submitted-but-unconfirmed replay decision tests\n");

  const cases: Array<[string, ReplayObservation, ReplayOutcome, boolean, boolean]> = [
    // label, observation, outcome, requires_lookup, may_resubmit
    ["refused submission is rejected and may be resubmitted", { outage_id: "O1", submit_result: "rejected" }, "rejected", false, true],
    ["accepted but unconfirmed needs a lookup and is not rejected", { outage_id: "O2", submit_result: "accepted" }, "submitted_unconfirmed", true, false],
    ["timeout is unknown, needs a lookup, not resubmittable", { outage_id: "O3", submit_result: "timeout" }, "unknown", true, false],
    ["dropped connection is unknown, needs a lookup, not resubmittable", { outage_id: "O4", submit_result: "connection_lost" }, "unknown", true, false],
    ["lookup confirmed is finalized", { outage_id: "O5", submit_result: "timeout", lookup: "confirmed" }, "finalized", false, false],
    ["lookup failed is rejected and may be resubmitted", { outage_id: "O6", submit_result: "accepted", lookup: "failed" }, "rejected", false, true],
    ["lookup found nothing stays unconfirmed, not resubmittable", { outage_id: "O7", submit_result: "timeout", lookup: "not_found" }, "submitted_unconfirmed", false, false],
  ];
  for (const [label, obs, outcome, requiresLookup, mayResubmit] of cases) {
    const d = decideReplay(obs);
    if (d.outcome !== outcome) throw new Error(`"${label}": outcome ${d.outcome}, expected ${outcome}`);
    if (d.requires_lookup !== requiresLookup) throw new Error(`"${label}": requires_lookup mismatch`);
    if (d.may_resubmit !== mayResubmit) throw new Error(`"${label}": may_resubmit mismatch`);
    console.log(`  ✓ ${label}`);
  }

  // Adversarial: resubmission is only ever allowed for a definitive rejection, and never without a lookup first
  // when the submit outcome was ambiguous.
  for (const submit_result of ["accepted", "timeout", "connection_lost"] as const) {
    const d = decideReplay({ outage_id: "OX", submit_result });
    if (d.may_resubmit || !d.requires_lookup) throw new Error(`${submit_result} without a lookup must require one and forbid resubmission`);
    if (d.outcome === "rejected") throw new Error(`${submit_result} must not be classified as rejected`);
  }
  console.log("  ✓ adversarial: no ambiguous outcome is ever rejected or resubmittable before a lookup");

  console.log("\nAll replay decision tests passed.");
}

function runTests(): void {
  console.log("[SC-W5-114] Ambiguous outcome replay workflow tests\n");

  // Found in history -> confirmed, no retry
  const r1 = reconcile({ outage_id: "OUT001" }, ["OUT001", "OUT002"]);
  if (r1.verdict !== "confirmed" || r1.safe_to_retry) throw new Error("Expected confirmed, no retry");
  console.log("  ✓ found in history -> confirmed, no_op");

  // Not found, ledger window closed -> safe to retry
  const r2 = reconcile(
    { outage_id: "OUT003", expected_ledger_min: 1000, expected_ledger_max: 1010 },
    ["OUT001"]
  );
  if (r2.verdict !== "not_applied" || !r2.safe_to_retry || r2.action !== "retry")
    throw new Error("Expected not_applied + retry");
  console.log("  ✓ not found + closed window -> not_applied, retry");

  // Not found, no ledger window -> indeterminate
  const r3 = reconcile({ outage_id: "OUT004" }, []);
  if (r3.verdict !== "indeterminate" || r3.safe_to_retry || r3.action !== "escalate")
    throw new Error("Expected indeterminate + escalate");
  console.log("  ✓ not found + no window -> indeterminate, escalate");

  // Adversarial: empty outage_id
  const r4 = reconcile({ outage_id: "" }, ["OUT001"]);
  if (r4.verdict !== "indeterminate") throw new Error("Empty outage_id should yield indeterminate");
  console.log("  ✓ adversarial: empty outage_id -> indeterminate");

  console.log("\nAll replay workflow tests passed.");
}

runTests();
runReplayDecisionTests();
