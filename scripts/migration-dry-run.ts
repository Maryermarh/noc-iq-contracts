/** Mirrors CURRENT_STORAGE_VERSION in sla_calculator/src/storage_migration.rs. */
export const CURRENT_STORAGE_VERSION = 1;

/**
 * Supported single-step upgrades (from -> to). Add an entry here together
 * with the matching step in storage_migration.rs when the schema version
 * is bumped; any jump not reachable through these steps is unsupported.
 */
export const SUPPORTED_UPGRADES: Record<number, number[]> = {};

export interface MigrationContext {
  network: "testnet" | "mainnet";
  contractId: string;
  /** Schema version currently deployed (when known). */
  deployedVersion?: number;
  /** Schema version the migration should reach (when known). */
  targetVersion?: number;
}

export interface VersionPlan {
  ok: boolean;
  source: number;
  target: number;
  path: number[];
  error?: string;
}

/**
 * Verifies the target schema version is reachable from the deployed one
 * through supported upgrade steps. Pure: it never touches the network or
 * contract state, so an unsupported jump fails before any mutation.
 */
export function planVersionPath(
  source: number,
  target: number,
  upgrades: Record<number, number[]> = SUPPORTED_UPGRADES,
  current: number = CURRENT_STORAGE_VERSION,
): VersionPlan {
  const fail = (error: string): VersionPlan => ({ ok: false, source, target, path: [], error });
  if (!Number.isInteger(source) || !Number.isInteger(target) || source < 1 || target < 1) {
    return fail(`Invalid schema versions: source=${source} target=${target}`);
  }
  if (target > current) {
    return fail(`Target v${target} is newer than this build supports (v${current}).`);
  }
  if (source > target) {
    return fail(`Downgrade from v${source} to v${target} is not supported.`);
  }
  if (source === target) return { ok: true, source, target, path: [source] };
  // BFS over supported single-step upgrades.
  const queue: number[][] = [[source]];
  const seen = new Set<number>([source]);
  while (queue.length) {
    const path = queue.shift()!;
    const last = path[path.length - 1];
    for (const next of upgrades[last] ?? []) {
      if (seen.has(next)) continue;
      const np = [...path, next];
      if (next === target) return { ok: true, source, target, path: np };
      seen.add(next);
      queue.push(np);
    }
  }
  return fail(`No supported upgrade path from v${source} to v${target}.`);
}

interface MigrationStep {
  id: string;
  description: string;
  reversible: boolean;
  dryRun: (ctx: MigrationContext) => string;
}

const steps: MigrationStep[] = [
  { id: "step-01", description: "Validate config version hash",     reversible: true,  dryRun: (c) => `[DRY] Check config hash on ${c.network}` },
  { id: "step-02", description: "Freeze governance during migration",reversible: false, dryRun: (c) => `[DRY] Freeze governance on ${c.contractId}` },
  { id: "step-03", description: "Apply schema upgrade",             reversible: false, dryRun: (c) => `[DRY] Upgrade schema on ${c.network}` },
  { id: "step-04", description: "Verify post-migration state",      reversible: true,  dryRun: (c) => `[DRY] Verify state on ${c.contractId}` },
];

export function runDryRun(ctx: MigrationContext): VersionPlan | undefined {
  console.log(`Migration dry-run — contract: ${ctx.contractId}  network: ${ctx.network}\n`);
  let plan: VersionPlan | undefined;
  if (ctx.deployedVersion !== undefined && ctx.targetVersion !== undefined) {
    plan = planVersionPath(ctx.deployedVersion, ctx.targetVersion);
    console.log(`  Source version: v${plan.source}`);
    console.log(`  Target version: v${plan.target}`);
    if (!plan.ok) {
      console.error(`\nDry-run FAILED before any step was planned: ${plan.error}`);
      process.exitCode = 1;
      return plan;
    }
    console.log(`  Upgrade path:   ${plan.path.map((v) => `v${v}`).join(" -> ")}\n`);
  }
  for (const s of steps) {
    console.log(`  [${s.id}] ${s.description}  (reversible: ${s.reversible})`);
    console.log(`    ${s.dryRun(ctx)}`);
  }
  console.log("\nDry-run complete. No changes applied.");
  return plan;
}
