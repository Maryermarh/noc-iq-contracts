/**
 * SC-W5-113: Finality-state annotation model for payout intents.
 *
 * Payout intents must carry an explicit finality annotation so the backend
 * can distinguish between pending, in-flight, finalized, and rolled-back
 * states without polling contract storage on every request.
 */

export type FinalityState =
  | "pending"      // intent created, not yet submitted
  | "submitted"    // submitted to Stellar, awaiting inclusion
  | "finalized"    // included in a closed ledger; contract state written
  | "rolled_back"  // tx failed after submission; contract state unchanged
  | "expired";     // submission window passed without confirmation

export interface PayoutIntent {
  outage_id: string;
  amount: number;
  recipient: string;
  finality: FinalityState;
  ledger_sequence?: number; // set when finalized
  tx_hash?: string;
  /** Audited corrections applied to a finalized intent (see {@link recoverFinalized}). */
  recovery_audit?: RecoveryAudit[];
}

export interface RecoveryAudit {
  reason: string;
  actor: string;
  recorded_at: number; // unix ms
  /** Finality state that was undone. */
  from: FinalityState;
}

/** Allowed finality state transitions. */
const TRANSITIONS: Record<FinalityState, FinalityState[]> = {
  pending:     ["submitted"],
  submitted:   ["finalized", "rolled_back", "expired"],
  finalized:   [],           // terminal
  rolled_back: ["pending"],  // can requeue
  expired:     ["pending"],  // can requeue
};

export function transition(
  intent: PayoutIntent,
  next: FinalityState
): PayoutIntent {
  const allowed = TRANSITIONS[intent.finality];
  if (!allowed.includes(next)) {
    throw new Error(
      `[SC-W5-113] Invalid transition ${intent.finality} -> ${next} for ${intent.outage_id}`
    );
  }
  return { ...intent, finality: next };
}

export interface ReconcileResult {
  intent: PayoutIntent;
  applied: boolean;
  /** Why an observation was not applied. */
  reason?: string;
}

/**
 * Reconciles a later observation of the payout with the stored intent. A late `pending` or
 * `submitted` observation can never move a finalized payout backward: it is ignored and the
 * intent is returned unchanged. Any other observation must be a legal transition.
 */
export function reconcileObservation(intent: PayoutIntent, observed: FinalityState): ReconcileResult {
  if (observed === intent.finality) {
    return { intent, applied: false, reason: "already in this state" };
  }
  if (intent.finality === "finalized") {
    return {
      intent,
      applied: false,
      reason: `finalized payout ignores late ${observed} observation; use recoverFinalized for an audited correction`,
    };
  }
  if (!TRANSITIONS[intent.finality].includes(observed)) {
    return { intent, applied: false, reason: `illegal transition ${intent.finality} -> ${observed}` };
  }
  return { intent: transition(intent, observed), applied: true };
}

/**
 * The only way back out of `finalized`: an explicit, audited recovery (for example after a
 * chain reorganization). It records who did it and why, and requeues the intent as `pending`.
 */
export function recoverFinalized(intent: PayoutIntent, audit: Omit<RecoveryAudit, "from">): PayoutIntent {
  if (intent.finality !== "finalized") {
    throw new Error(`[SC-W5-113] recoverFinalized requires a finalized intent, got ${intent.finality} for ${intent.outage_id}`);
  }
  if (!audit.reason.trim() || !audit.actor.trim()) {
    throw new Error(`[SC-W5-113] recovery of ${intent.outage_id} requires a non-empty reason and actor`);
  }
  const { ledger_sequence: _ledger, tx_hash: _hash, ...rest } = intent;
  return {
    ...rest,
    finality: "pending",
    recovery_audit: [...(intent.recovery_audit ?? []), { ...audit, from: "finalized" }],
  };
}

function runTests(): void {
  console.log("[SC-W5-113] Finality-state annotation model tests\n");

  const base: PayoutIntent = { outage_id: "OUT001", amount: 500, recipient: "GABC", finality: "pending" };

  // Happy path: pending -> submitted -> finalized
  const submitted = transition(base, "submitted");
  if (submitted.finality !== "submitted") throw new Error("Expected submitted");
  console.log("  ✓ pending -> submitted");

  const finalized = transition(submitted, "finalized");
  if (finalized.finality !== "finalized") throw new Error("Expected finalized");
  console.log("  ✓ submitted -> finalized");

  // finalized is terminal
  try {
    transition(finalized, "pending");
    throw new Error("Should have thrown");
  } catch (e: any) {
    if (!e.message.includes("SC-W5-113")) throw e;
    console.log("  ✓ finalized -> pending rejected (terminal)");
  }

  // rolled_back allows requeue
  const rolled = transition(submitted, "rolled_back");
  const requeued = transition(rolled, "pending");
  if (requeued.finality !== "pending") throw new Error("Expected pending after requeue");
  console.log("  ✓ rolled_back -> pending (requeue)");

  // expired -> pending
  const expiredIntent: PayoutIntent = { ...base, finality: "submitted" };
  const expired = transition(expiredIntent, "expired");
  const requeuedFromExpired = transition(expired, "pending");
  if (requeuedFromExpired.finality !== "pending") throw new Error("Expected pending");
  console.log("  ✓ expired -> pending (requeue)");

  // Adversarial: skip submitted
  try {
    transition(base, "finalized");
    throw new Error("Should have thrown");
  } catch (e: any) {
    if (!e.message.includes("SC-W5-113")) throw e;
    console.log("  ✓ adversarial: pending -> finalized (skip) rejected");
  }

  // Late observations never move a finalized payout backward.
  const done: PayoutIntent = { ...finalized, ledger_sequence: 100, tx_hash: "TX" };
  for (const late of ["pending", "submitted", "rolled_back", "expired"] as FinalityState[]) {
    const r = reconcileObservation(done, late);
    if (r.applied || r.intent !== done) throw new Error(`Late ${late} observation must not change a finalized payout`);
  }
  console.log("  ✓ late pending/submitted/rolled_back/expired observations ignored after finality");

  const same = reconcileObservation(done, "finalized");
  if (same.applied) throw new Error("Re-observing finalized must be a no-op");
  console.log("  ✓ re-observing finalized is a no-op");

  const legal = reconcileObservation(base, "submitted");
  if (!legal.applied || legal.intent.finality !== "submitted") throw new Error("Legal observation should apply");
  const illegal = reconcileObservation(base, "finalized");
  if (illegal.applied || illegal.intent.finality !== "pending") throw new Error("Illegal observation must not apply");
  console.log("  ✓ legal observations apply, illegal ones are rejected without changing state");

  // The only way out of finality is the audited recovery path.
  const recovered = recoverFinalized(done, { reason: "ledger reorg", actor: "ops@noc", recorded_at: 1 });
  if (recovered.finality !== "pending" || recovered.tx_hash !== undefined || recovered.ledger_sequence !== undefined)
    throw new Error("Recovery should requeue as pending and clear chain references");
  if (recovered.recovery_audit?.length !== 1 || recovered.recovery_audit[0]!.from !== "finalized")
    throw new Error("Recovery must leave an audit record");
  if (done.finality !== "finalized") throw new Error("Recovery must not mutate the original intent");
  console.log("  ✓ recoverFinalized requeues with an audit record and leaves the original untouched");

  for (const bad of [{ reason: "", actor: "a" }, { reason: "r", actor: " " }]) {
    try {
      recoverFinalized(done, { ...bad, recorded_at: 1 });
      throw new Error("Should have thrown");
    } catch (e: any) {
      if (!e.message.includes("SC-W5-113")) throw e;
    }
  }
  try {
    recoverFinalized(base, { reason: "r", actor: "a", recorded_at: 1 });
    throw new Error("Should have thrown");
  } catch (e: any) {
    if (!e.message.includes("SC-W5-113")) throw e;
  }
  console.log("  ✓ adversarial: recovery needs a reason, an actor and a finalized intent");

  console.log("\nAll finality-state annotation tests passed.");
}

runTests();
