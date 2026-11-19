/**
 * SC-016 / SC-W5-029: Read-cost regression tests for history, config-bundle,
 * and version negotiation helpers.
 * Simulates budget-aware reads against contract view helpers and asserts
 * that response sizes stay within documented thresholds.
 */

const READ_BUDGET_LIMITS = {
  historyRead: 512,    // bytes
  configBundle: 256,
  metadataRead: 128,
  versionInfo: 96,     // SC-W5-029: version negotiation must be compact
};

interface ReadSample {
  helper: keyof typeof READ_BUDGET_LIMITS;
  payload: unknown;
}

function measurePayloadSize(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function assertReadBudget(sample: ReadSample): void {
  const limit = READ_BUDGET_LIMITS[sample.helper];
  const size = measurePayloadSize(sample.payload);
  if (size > limit) {
    throw new Error(
      `[SC-016] ${sample.helper} payload ${size}B exceeds budget ${limit}B`
    );
  }
  console.log(`  ✓ ${sample.helper}: ${size}B / ${limit}B`);
}

// ---------------------------------------------------------------------------
// #1064: scenario inventory
// ---------------------------------------------------------------------------

export interface ExpectedScenario {
  name: string;
  /** Earlier names of this scenario, so a rename is reported as a rename rather than a removal. */
  formerNames?: string[];
}

export interface ScenarioInventoryReport {
  /** Expected scenarios that were not measured and are not explained by a rename. */
  missing: string[];
  /** Expected scenarios that were measured under a former name. */
  renamed: Array<{ from: string; to: string }>;
  /** Measured scenarios that are not in the expected inventory. */
  added: string[];
}

/** Compares the expected scenario inventory with the measured set; the three outcomes are reported separately. */
export function compareScenarioInventory(
  expected: ExpectedScenario[],
  measured: string[]
): ScenarioInventoryReport {
  const measuredSet = new Set(measured);
  const claimed = new Set<string>();
  const missing: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  for (const scenario of expected) {
    if (measuredSet.has(scenario.name)) {
      claimed.add(scenario.name);
      continue;
    }
    const former = (scenario.formerNames ?? []).find((n) => measuredSet.has(n));
    if (former !== undefined) {
      claimed.add(former);
      renamed.push({ from: former, to: scenario.name });
    } else {
      missing.push(scenario.name);
    }
  }
  const added = measured.filter((m) => !claimed.has(m));
  return { missing, renamed, added };
}

/** Throws unless the measured set is exactly the expected inventory, naming every difference. */
export function assertScenarioInventory(expected: ExpectedScenario[], measured: string[]): void {
  const r = compareScenarioInventory(expected, measured);
  if (r.missing.length === 0 && r.renamed.length === 0 && r.added.length === 0) return;
  const parts: string[] = [];
  if (r.missing.length) parts.push(`missing: ${r.missing.join(", ")}`);
  if (r.renamed.length) parts.push(`renamed: ${r.renamed.map((x) => `${x.from} -> ${x.to}`).join(", ")}`);
  if (r.added.length) parts.push(`added: ${r.added.join(", ")}`);
  throw new Error(`[SC-016] Read-cost scenario inventory changed (${parts.join("; ")}). Update the expected inventory deliberately.`);
}

/** Aggregate of measured sizes; only meaningful once the inventory has been verified. */
export function totalMeasuredBytes(samples: ReadSample[]): number {
  return samples.reduce((sum, s) => sum + measurePayloadSize(s.payload), 0);
}

const EXPECTED_SCENARIOS: ExpectedScenario[] = [
  { name: "historyRead" },
  { name: "configBundle" },
  { name: "metadataRead" },
  { name: "versionInfo" },
];

function expectInventoryFailure(
  expected: ExpectedScenario[],
  measured: string[],
  want: Partial<ScenarioInventoryReport>
): void {
  const got = compareScenarioInventory(expected, measured);
  for (const key of ["missing", "renamed", "added"] as const) {
    const w = want[key] ?? [];
    if (JSON.stringify(got[key]) !== JSON.stringify(w))
      throw new Error(`[SC-016] inventory ${key}: expected ${JSON.stringify(w)}, got ${JSON.stringify(got[key])}`);
  }
  let threw = false;
  try { assertScenarioInventory(expected, measured); } catch { threw = true; }
  if (!threw) throw new Error("[SC-016] assertScenarioInventory should have thrown");
}

function runInventoryChecks(): void {
  console.log("[SC-016 / #1064] Scenario inventory checks:");
  const names = EXPECTED_SCENARIOS.map((s) => s.name);

  assertScenarioInventory(EXPECTED_SCENARIOS, names);
  console.log("  ✓ matching inventory passes");

  expectInventoryFailure(EXPECTED_SCENARIOS, names.filter((n) => n !== "configBundle"), { missing: ["configBundle"] });
  console.log("  ✓ a removed scenario is reported as missing");

  expectInventoryFailure(EXPECTED_SCENARIOS, [...names, "newScenario"], { added: ["newScenario"] });
  console.log("  ✓ a new scenario is reported as added");

  expectInventoryFailure(
    EXPECTED_SCENARIOS,
    names.map((n) => (n === "versionInfo" ? "versionInfoV2" : n)),
    { missing: ["versionInfo"], added: ["versionInfoV2"] }
  );
  console.log("  ✓ an unannounced rename shows up as one missing and one added scenario");

  const withHistory: ExpectedScenario[] = [
    { name: "historyRead" },
    { name: "configBundle" },
    { name: "metadataRead" },
    { name: "versionInfoV2", formerNames: ["versionInfo"] },
  ];
  expectInventoryFailure(withHistory, names, { renamed: [{ from: "versionInfo", to: "versionInfoV2" }] });
  console.log("  ✓ a declared rename is reported as renamed, not missing or added");

  expectInventoryFailure(EXPECTED_SCENARIOS, [], { missing: names });
  console.log("  ✓ an empty measurement fails instead of passing with a zero aggregate");
}

const mockHistoryRead = Array.from({ length: 5 }, (_, i) => ({
  id: i,
  severity: "critical",
  mttr: 30 + i,
  sla_met: true,
}));

const mockConfigBundle = {
  critical: { threshold: 60, penalty: 10, reward: 5 },
  high: { threshold: 120, penalty: 8, reward: 4 },
  medium: { threshold: 240, penalty: 5, reward: 2 },
};

const mockMetadataRead = {
  version: "1.0.0",
  paused: false,
  operator: "GABC",
};

// SC-W5-029: version negotiation response must be compact
const mockVersionInfo = {
  storage_version: 1,
  result_schema_version: 1,
  needs_migration: false,
  is_paused: false,
  contract_name: "sla_calc",
};

const samples: ReadSample[] = [
  { helper: "historyRead", payload: mockHistoryRead },
  { helper: "configBundle", payload: mockConfigBundle },
  { helper: "metadataRead", payload: mockMetadataRead },
  { helper: "versionInfo", payload: mockVersionInfo },
];

runInventoryChecks();

// The measured set must match the inventory before any budget (or aggregate) is trusted.
assertScenarioInventory(EXPECTED_SCENARIOS, samples.map((s) => s.helper));

console.log("[SC-016/SC-W5-029] Read-cost regression checks:");
samples.forEach(assertReadBudget);
console.log(`  total measured: ${totalMeasuredBytes(samples)}B across ${samples.length} scenarios`);
console.log("All read-cost checks passed.");
