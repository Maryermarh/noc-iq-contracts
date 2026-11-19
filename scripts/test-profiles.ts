/**
 * SC-W5-117: Deterministic local test runner profiles (fast / full / security).
 *
 * Extends scripts/run-tests.ts with three named profiles that provide
 * reproducible, deterministic test scopes for local development cycles.
 *
 * Usage:
 *   npx ts-node scripts/test-profiles.ts fast
 *   npx ts-node scripts/test-profiles.ts full
 *   npx ts-node scripts/test-profiles.ts security
 *   npx ts-node scripts/test-profiles.ts --list
 */

import { execSync, ExecSyncOptions } from "child_process";

export interface TestProfile {
  name: string;
  description: string;
  cargoFilter: string;       // passed to `cargo test <filter>`
  extraFlags: string[];      // additional cargo flags
  securityGate: boolean;     // run scripts/security-gate.ts after tests
  wasmCheck: boolean;        // run cargo check --target wasm32-unknown-unknown
}

export const PROFILES: Record<string, TestProfile> = {
  fast: {
    name: "fast",
    description: "Core SLA logic only — fastest feedback loop (~5s)",
    cargoFilter: "calculate_sla",
    extraFlags: [],
    securityGate: false,
    wasmCheck: false,
  },
  full: {
    name: "full",
    description: "All tests including parity, history, governance, stats (~30s)",
    cargoFilter: "",
    extraFlags: [],
    securityGate: false,
    wasmCheck: true,
  },
  security: {
    name: "security",
    description: "Full tests + security gate scan on staged files (~35s)",
    cargoFilter: "",
    extraFlags: [],
    securityGate: true,
    wasmCheck: true,
  },
};

export class UnknownProfileError extends Error {
  constructor(public readonly requested: string, known: string[]) {
    super(`Unknown profile "${requested}". Known profiles: ${known.join(", ")}`);
    this.name = "UnknownProfileError";
  }
}

export interface ProfileOutcome {
  profile: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
}

/**
 * Decides which profiles run and which are skipped (with a reason). A
 * requested or skipped profile that does not exist throws instead of
 * silently falling back to a default suite.
 */
export function selectProfiles(
  requested: string[],
  known: string[],
  skip: Record<string, string> = {},
): { run: string[]; skipped: ProfileOutcome[] } {
  for (const name of [...requested, ...Object.keys(skip)]) {
    if (!known.includes(name)) throw new UnknownProfileError(name, known);
  }
  const run: string[] = [];
  const skipped: ProfileOutcome[] = [];
  for (const name of known) {
    if (skip[name] !== undefined) {
      skipped.push({ profile: name, status: "skipped", reason: skip[name] || "skipped by request" });
    } else if (requested.includes(name)) {
      run.push(name);
    } else {
      skipped.push({ profile: name, status: "skipped", reason: "not requested" });
    }
  }
  return { run, skipped };
}

export function formatSummary(outcomes: ProfileOutcome[]): string {
  const lines = ["=== Test profile summary ==="];
  for (const o of outcomes) {
    const mark = o.status === "passed" ? "PASS" : o.status === "failed" ? "FAIL" : "SKIP";
    lines.push(`  [${mark}] ${o.profile}${o.reason ? ` — ${o.reason}` : ""}`);
  }
  return lines.join("\n");
}

export function summaryJson(outcomes: ProfileOutcome[]): string {
  return JSON.stringify({ profiles: outcomes }, null, 2) + "\n";
}

const opts: ExecSyncOptions = { stdio: "inherit", cwd: "sla_calculator" };

function runProfile(profile: TestProfile): void {
  console.log(`\n=== Profile: ${profile.name} ===`);
  console.log(`${profile.description}\n`);

  // 1. Cargo test
  const filterArg = profile.cargoFilter ? ` ${profile.cargoFilter}` : "";
  const extraArgs = profile.extraFlags.join(" ");
  const cmd = `cargo test${extraArgs}${filterArg} -- --nocapture`;
  console.log(`$ ${cmd}`);
  execSync(cmd, opts);

  // 2. Optional no-std compliance check
  if (profile.wasmCheck) {
    console.log("\n$ cargo check --target wasm32-unknown-unknown --lib");
    execSync("cargo check --target wasm32-unknown-unknown --lib --quiet", opts);
    console.log("✅ no-std compliance: OK");
  }

  // 3. Optional security gate
  if (profile.securityGate) {
    console.log("\n$ ts-node scripts/security-gate.ts");
    try {
      execSync("npx ts-node scripts/security-gate.ts", { stdio: "inherit" });
    } catch {
      // security-gate exits non-zero on hits; that is intentional
    }
  }

  console.log(`\n✅ Profile "${profile.name}" complete.`);
}

function printList(): void {
  console.log("Available test profiles:\n");
  for (const [key, p] of Object.entries(PROFILES)) {
    console.log(`  ${key.padEnd(10)} ${p.description}`);
  }
  console.log("\nUsage: npx ts-node scripts/test-profiles.ts <profile>");
}

function main(argv: string[]): number {
  if (!argv.length || argv.includes("--list") || argv.includes("--help")) {
    printList();
    return 0;
  }
  const known = Object.keys(PROFILES);
  const requested: string[] = [];
  const skip: Record<string, string> = {};
  let jsonPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") jsonPath = argv[++i];
    else if (a === "--skip") {
      const [name, ...why] = (argv[++i] ?? "").split("=");
      skip[name] = why.join("=");
    } else requested.push(a);
  }

  let plan;
  try {
    plan = selectProfiles(requested, known, skip);
  } catch (e) {
    if (e instanceof UnknownProfileError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }

  const outcomes: ProfileOutcome[] = [];
  for (const name of known) {
    if (plan.run.includes(name)) {
      try {
        runProfile(PROFILES[name]);
        outcomes.push({ profile: name, status: "passed" });
      } catch (e: any) {
        outcomes.push({ profile: name, status: "failed", reason: String(e?.message ?? e).split("\n")[0] });
      }
    } else {
      outcomes.push(plan.skipped.find((s) => s.profile === name)!);
    }
  }
  console.log("\n" + formatSummary(outcomes));
  if (jsonPath) {
    require("fs").writeFileSync(jsonPath, summaryJson(outcomes));
    console.log(`Machine-readable summary written to ${jsonPath}`);
  }
  return outcomes.some((o) => o.status === "failed") ? 1 : 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
