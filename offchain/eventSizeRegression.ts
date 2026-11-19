/**
 * SC-017 / SC-W5-029: Event-size regression tests for lifecycle, SLA calculation,
 * and version negotiation events.
 * Catches payload bloat before deployment by asserting max byte sizes per event type.
 */

import * as fs from "fs";
import * as path from "path";

/** Baseline format version this checker understands. Bump it together with the baseline file. */
export const EVENT_BASELINE_VERSION = 1;

/** Where the committed baseline lives. */
export const EVENT_BASELINE_PATH = path.resolve(__dirname, "../artifacts/event-size-baseline.json");

export interface EventSizeBaseline {
  version: number;
  /** Max serialized payload bytes per event type. */
  limits: Record<string, number>;
}

/**
 * Parses and validates a baseline. A missing file, unreadable JSON, a different `version`, or a set
 * of event types that no longer matches the ones being measured all fail with an actionable message
 * instead of letting the check pass vacuously.
 */
export function loadEventBaseline(
  measuredTypes: string[],
  file: string = EVENT_BASELINE_PATH,
  readFile: (p: string) => string = (p) => fs.readFileSync(p, "utf8")
): EventSizeBaseline {
  const regenerate = `Update ${path.basename(file)} deliberately after reviewing the event schema.`;
  let text: string;
  try {
    text = readFile(file);
  } catch {
    throw new Error(`[SC-017] Event size baseline not found at ${file}. Restore it from git or recreate it. ${regenerate}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`[SC-017] Event size baseline ${file} is not valid JSON. ${regenerate}`);
  }
  const b = raw as Partial<EventSizeBaseline> | null;
  if (b === null || typeof b !== "object" || typeof b.limits !== "object" || b.limits === null) {
    throw new Error(`[SC-017] Event size baseline ${file} has no "limits" object. ${regenerate}`);
  }
  if (b.version !== EVENT_BASELINE_VERSION) {
    throw new Error(
      `[SC-017] Event size baseline version ${String(b.version)} is stale; this checker needs version ${EVENT_BASELINE_VERSION}. ${regenerate}`
    );
  }
  const limits = b.limits as Record<string, unknown>;
  for (const [type, limit] of Object.entries(limits)) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
      throw new Error(`[SC-017] Baseline limit for "${type}" must be a positive number of bytes, got ${JSON.stringify(limit)}`);
    }
  }
  const missing = measuredTypes.filter((t) => !(t in limits));
  const stale = Object.keys(limits).filter((t) => !measuredTypes.includes(t));
  if (missing.length || stale.length) {
    throw new Error(
      `[SC-017] Event size baseline is out of date` +
        (missing.length ? `; no limit for: ${missing.join(", ")}` : "") +
        (stale.length ? `; limits for events no longer measured: ${stale.join(", ")}` : "") +
        `. ${regenerate}`
    );
  }
  return { version: b.version, limits: limits as Record<string, number> };
}

interface ContractEvent {
  type: string;
  payload: Record<string, unknown>;
}

function eventSize(event: ContractEvent): number {
  return Buffer.byteLength(JSON.stringify(event.payload), "utf8");
}

function assertEventSize(event: ContractEvent, limits: Record<string, number>): void {
  const limit = limits[event.type];
  if (limit === undefined) throw new Error(`Unknown event type: ${event.type}`);
  const size = eventSize(event);
  if (size > limit) {
    throw new Error(
      `[SC-017] Event "${event.type}" is ${size}B, limit is ${limit}B`
    );
  }
  console.log(`  ✓ ${event.type}: ${size}B / ${limit}B`);
}

const events: ContractEvent[] = [
  {
    type: "sla_calculated",
    payload: { severity: "critical", mttr: 45, sla_met: true, reward_tier: "good" },
  },
  {
    type: "contract_paused",
    payload: { reason: "maintenance", timestamp: 1714233600 },
  },
  {
    type: "contract_unpaused",
    payload: { timestamp: 1714237200 },
  },
  {
    type: "admin_proposed",
    payload: { proposed: "GABC123", proposer: "GXYZ456" },
  },
  {
    type: "operator_proposed",
    payload: { proposed: "GDEF789", proposer: "GXYZ456" },
  },
  {
    // SC-W5-029: version negotiation read is not an emitted event but its
    // response payload must stay compact for backend startup latency budgets.
    type: "version_info_read",
    payload: { storage_version: 1, result_schema_version: 1, needs_migration: false, is_paused: false },
  },
];

function expectBaselineError(label: string, want: RegExp, readFile: (p: string) => string, types = events.map((e) => e.type)): void {
  try {
    loadEventBaseline(types, "/virtual/event-size-baseline.json", readFile);
  } catch (e: any) {
    if (!want.test(e.message)) throw new Error(`[SC-017] "${label}": unexpected message: ${e.message}`);
    console.log(`  ✓ ${label}`);
    return;
  }
  throw new Error(`[SC-017] "${label}": expected a failure`);
}

function runBaselineChecks(): void {
  console.log("[SC-017 / #1056] Baseline validation checks:");
  const good = { version: EVENT_BASELINE_VERSION, limits: Object.fromEntries(events.map((e) => [e.type, 500])) };
  const types = events.map((e) => e.type);
  loadEventBaseline(types, "/virtual/b.json", () => JSON.stringify(good));
  console.log("  ✓ a current baseline loads");

  expectBaselineError("a missing baseline fails with its path", /not found at \/virtual\/event-size-baseline\.json/, () => {
    throw new Error("ENOENT");
  });
  expectBaselineError("invalid JSON fails", /not valid JSON/, () => "{ nope");
  expectBaselineError("a stale version fails", /version 0 is stale/, () => JSON.stringify({ ...good, version: 0 }));
  expectBaselineError("a missing version fails", /version undefined is stale/, () => JSON.stringify({ limits: good.limits }));
  expectBaselineError("a baseline without limits fails", /no "limits" object/, () => JSON.stringify({ version: 1 }));
  expectBaselineError("an event without a limit fails", /no limit for: contract_paused/, () => {
    const { contract_paused: _drop, ...limits } = good.limits;
    return JSON.stringify({ ...good, limits });
  });
  expectBaselineError("limits for events no longer measured fail", /no longer measured: removed_event/, () =>
    JSON.stringify({ ...good, limits: { ...good.limits, removed_event: 10 } })
  );
  expectBaselineError("a non-positive limit fails", /positive number/, () =>
    JSON.stringify({ ...good, limits: { ...good.limits, sla_calculated: 0 } })
  );
}

runBaselineChecks();

console.log("[SC-017/SC-W5-029] Event-size regression checks:");
const baseline = loadEventBaseline(events.map((e) => e.type));
events.forEach((e) => assertEventSize(e, baseline.limits));
console.log("All event-size checks passed.");
