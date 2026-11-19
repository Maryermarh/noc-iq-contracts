/**
 * SC-043: Focused test runner for faster local contract test cycles.
 * Wraps `cargo test` with filter presets so contributors skip unrelated tests.
 */

import { execSync, ExecSyncOptions } from "child_process";

export const PRESETS: Record<string, string> = {
  governance: "governance",
  calc:       "calculate_sla",
  stats:      "stats",
  pause:      "pause",
  history:    "history",
  parity:     "backend_parity",
  all:        "",
};

const opts: ExecSyncOptions = { stdio: "inherit", cwd: "sla_calculator" };

function run(filter: string, release: boolean): void {
  const filterArg = filter ? ` ${filter}` : "";
  const profile = release ? " --release" : "";
  const cmd = `cargo test${profile}${filterArg} -- --nocapture`;
  console.log(`\n$ ${cmd}\n`);
  execSync(cmd, opts);
}

function printHelp(): void {
  console.log("Usage: ts-node run-tests.ts <preset|filter> [--release]");
  console.log("       ts-node run-tests.ts --profile <preset> [--release]   (unknown preset fails)");
  console.log("\nPresets:");
  for (const [name, filter] of Object.entries(PRESETS)) {
    console.log(`  ${name.padEnd(12)} → cargo test ${filter || "(all)"}`);
  }
  console.log("\nOr pass any string to use as a direct cargo test filter.");
  console.log("\nExamples:");
  console.log("  ts-node scripts/run-tests.ts governance");
  console.log("  ts-node scripts/run-tests.ts parity --release");
  console.log("  ts-node scripts/run-tests.ts test_pause_blocks_calculate");
}

/**
 * Resolves `--profile <name>` strictly: an unknown name throws instead of
 * being treated as a cargo filter (which would silently run a different suite).
 */
export function resolveProfile(name: string): string {
  if (!(name in PRESETS)) {
    throw new Error(`Unknown profile "${name}". Known profiles: ${Object.keys(PRESETS).join(", ")}`);
  }
  return PRESETS[name];
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === "--help") {
    printHelp();
    process.exit(0);
  }

  const release = args.includes("--release");
  const profileIdx = args.indexOf("--profile");
  let filter: string;
  let label = args[0];
  if (profileIdx !== -1) {
    label = args[profileIdx + 1] ?? "";
    try {
      filter = resolveProfile(label);
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
  } else {
    filter = PRESETS[label] !== undefined ? PRESETS[label] : label;
  }
  console.log(`Profile/filter: ${label}`);

  run(filter!, release);
}
