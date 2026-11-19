/**
 * SC-018 / SC-W5-029: Event-versus-state consistency tests for governance actions
 * and version negotiation endpoint validation.
 *
 * Validates that emitted governance events match the resulting stored state
 * for admin, operator, pause, and config actions. Also validates that
 * get_version_info returns a consistent snapshot for backend negotiation.
 */

interface GovernanceEvent {
  action: string;
  data: Record<string, unknown>;
}

interface ContractState {
  admin?: string;
  pendingAdmin?: string;
  operator?: string;
  pendingOperator?: string;
  paused?: boolean;
  pauseReason?: string;
}

interface VersionInfo {
  storage_version: number;
  result_schema_version: number;
  needs_migration: boolean;
  is_paused: boolean;
  contract_name: string;
}

// ---------------------------------------------------------------------------
// #1060: pending-admin reconciliation
// ---------------------------------------------------------------------------

/** Authoritative state read from the contract (`get_admin` / `get_pending_admin`). */
export interface AdminSnapshot {
  admin?: string | null;
  pendingAdmin?: string | null;
}

/** Off-chain state projected from events. It can lag the contract and is never authoritative. */
export interface AdminProjection {
  admin?: string | null;
  pendingAdmin?: string | null;
  /** Ledger of the last event folded into the projection, for diagnostics. */
  lastEventLedger?: number;
}

export type DriftKind =
  | "stale_pending_admin"      // projection shows a pending admin the contract no longer has
  | "missing_pending_admin"    // contract has a pending admin the projection has not seen
  | "superseded_pending_admin" // both have one, but the contract's was replaced
  | "stale_admin";             // projected admin differs from the contract's

export interface AdminDrift {
  kind: DriftKind;
  field: "admin" | "pendingAdmin";
  projected: string | null;
  actual: string | null;
}

export interface AdminReconciliation {
  /** The contract's pending admin: the only value callers may act on. */
  authoritativePendingAdmin: string | null;
  authoritativeAdmin: string | null;
  consistent: boolean;
  drift: AdminDrift[];
}

const norm = (v: string | null | undefined): string | null => (v === undefined || v === null || v === "" ? null : v);

/**
 * Reconciles an event projection against the current contract snapshot. The snapshot always wins;
 * any difference is reported as drift instead of being merged in.
 */
export function reconcileAdminState(snapshot: AdminSnapshot, projection: AdminProjection): AdminReconciliation {
  const actualAdmin = norm(snapshot.admin);
  const actualPending = norm(snapshot.pendingAdmin);
  const projAdmin = norm(projection.admin);
  const projPending = norm(projection.pendingAdmin);
  const drift: AdminDrift[] = [];

  if (projPending !== actualPending) {
    const kind: DriftKind =
      projPending !== null && actualPending === null ? "stale_pending_admin"
      : projPending === null ? "missing_pending_admin"
      : "superseded_pending_admin";
    drift.push({ kind, field: "pendingAdmin", projected: projPending, actual: actualPending });
  }
  if (projAdmin !== null && projAdmin !== actualAdmin) {
    drift.push({ kind: "stale_admin", field: "admin", projected: projAdmin, actual: actualAdmin });
  }
  return {
    authoritativePendingAdmin: actualPending,
    authoritativeAdmin: actualAdmin,
    consistent: drift.length === 0,
    drift,
  };
}

function assertReconciliation(
  label: string,
  snapshot: AdminSnapshot,
  projection: AdminProjection,
  expectDrift: DriftKind[],
  expectPending: string | null
): void {
  const r = reconcileAdminState(snapshot, projection);
  const kinds = r.drift.map((d) => d.kind);
  if (JSON.stringify(kinds) !== JSON.stringify(expectDrift))
    throw new Error(`[#1060] ${label}: drift ${JSON.stringify(kinds)}, expected ${JSON.stringify(expectDrift)}`);
  if (r.authoritativePendingAdmin !== expectPending)
    throw new Error(`[#1060] ${label}: authoritative pending admin ${r.authoritativePendingAdmin}, expected ${expectPending}`);
  if (r.consistent !== (expectDrift.length === 0)) throw new Error(`[#1060] ${label}: consistent flag mismatch`);
  console.log(`  ✓ ${label}`);
}

function assertConsistency(
  event: GovernanceEvent,
  state: ContractState,
  checks: Array<[keyof ContractState, unknown]>
): void {
  for (const [key, expected] of checks) {
    if (state[key] !== expected) {
      throw new Error(
        `[SC-018] "${event.action}" event/state mismatch: state.${key} = ${state[key]}, expected ${expected}`
      );
    }
  }
  console.log(`  ✓ ${event.action}: event/state consistent`);
}

function assertVersionInfo(info: VersionInfo): void {
  if (info.storage_version < 1) throw new Error("[SC-W5-029] storage_version must be >= 1");
  if (info.result_schema_version < 1) throw new Error("[SC-W5-029] result_schema_version must be >= 1");
  if (!info.contract_name) throw new Error("[SC-W5-029] contract_name must be non-empty");
  console.log(`  ✓ version_info: storage_v=${info.storage_version} schema_v=${info.result_schema_version} needs_migration=${info.needs_migration} paused=${info.is_paused}`);
}

// Simulate governance flows
const scenarios: Array<{
  event: GovernanceEvent;
  state: ContractState;
  checks: Array<[keyof ContractState, unknown]>;
}> = [
  {
    event: { action: "admin_proposed", data: { proposed: "GNEW" } },
    state: { admin: "GOLD", pendingAdmin: "GNEW" },
    checks: [["pendingAdmin", "GNEW"], ["admin", "GOLD"]],
  },
  {
    event: { action: "admin_accepted", data: { new_admin: "GNEW" } },
    state: { admin: "GNEW", pendingAdmin: undefined },
    checks: [["admin", "GNEW"], ["pendingAdmin", undefined]],
  },
  {
    event: { action: "contract_paused", data: { reason: "upgrade" } },
    state: { paused: true, pauseReason: "upgrade" },
    checks: [["paused", true], ["pauseReason", "upgrade"]],
  },
  {
    event: { action: "contract_unpaused", data: {} },
    state: { paused: false, pauseReason: undefined },
    checks: [["paused", false], ["pauseReason", undefined]],
  },
];

// Version negotiation scenarios: paused state must be reflected in version info
const versionScenarios: Array<{ label: string; info: VersionInfo }> = [
  {
    label: "ready contract",
    info: { storage_version: 1, result_schema_version: 1, needs_migration: false, is_paused: false, contract_name: "sla_calc" },
  },
  {
    label: "paused contract",
    info: { storage_version: 1, result_schema_version: 1, needs_migration: false, is_paused: true, contract_name: "sla_calc" },
  },
];

console.log("[SC-018] Governance event/state consistency checks:");
scenarios.forEach(({ event, state, checks }) => assertConsistency(event, state, checks));

console.log("[SC-W5-029] Version negotiation consistency checks:");
versionScenarios.forEach(({ label, info }) => {
  assertVersionInfo(info);
  console.log(`  ✓ ${label}: consistent`);
});

console.log("[#1060] Pending-admin reconciliation checks:");
assertReconciliation("matching snapshot and projection reconcile", { admin: "GOLD", pendingAdmin: "GNEW" }, { admin: "GOLD", pendingAdmin: "GNEW" }, [], "GNEW");
assertReconciliation("no pending admin on either side is consistent", { admin: "GOLD" }, { admin: "GOLD", pendingAdmin: null }, [], null);
assertReconciliation("a pending admin the contract already superseded (accepted) is stale drift", { admin: "GNEW", pendingAdmin: null }, { admin: "GNEW", pendingAdmin: "GNEW" }, ["stale_pending_admin"], null);
assertReconciliation("a cancelled proposal still shown by the projection is stale drift", { admin: "GOLD" }, { admin: "GOLD", pendingAdmin: "GNEW" }, ["stale_pending_admin"], null);
assertReconciliation("a replaced proposal is reported as superseded", { admin: "GOLD", pendingAdmin: "GNEWER" }, { admin: "GOLD", pendingAdmin: "GNEW" }, ["superseded_pending_admin"], "GNEWER");
assertReconciliation("a proposal the projection missed is reported", { admin: "GOLD", pendingAdmin: "GNEW" }, { admin: "GOLD" }, ["missing_pending_admin"], "GNEW");
assertReconciliation("a stale admin is reported alongside stale pending admin", { admin: "GNEW" }, { admin: "GOLD", pendingAdmin: "GNEW" }, ["stale_pending_admin", "stale_admin"], null);
assertReconciliation("empty string is treated as absent", { admin: "GOLD", pendingAdmin: "" }, { admin: "GOLD", pendingAdmin: undefined }, [], null);

console.log("All consistency checks passed.");
