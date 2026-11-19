/**
 * SC-W5-123: Post-deploy smoke verification pipeline for critical entrypoints.
 *
 * After deploying a new contract version, this pipeline exercises the critical
 * read-only and view entrypoints against the live contract to confirm the
 * deployment is healthy before routing backend traffic.
 */

export interface ContractClient {
  getAdmin(): Promise<string>;
  getOperator(): Promise<string>;
  isPaused(): Promise<boolean>;
  getConfig(severity: string): Promise<{ threshold_minutes: number }>;
  getStats(): Promise<{ total_calculations: number }>;
  getConfigSnapshot(): Promise<{ version: string; entries: unknown[] }>;
  /** Optional version view; checked first when the client provides it. */
  getVersionInfo?(): Promise<{ contract_name: string; storage_version: number }>;
  /** Optional state-changing probe; only run when explicitly opted in. */
  writeProbe?(): Promise<string>;
}

export interface SmokeResult {
  check: string;
  passed: boolean;
  detail: string;
  /** "read" for view calls, "write" for opt-in state-changing probes. */
  phase?: "read" | "write";
  /** True when a requested write probe was not run. */
  skipped?: boolean;
}

export interface SmokeOptions {
  /** Opt in to write probes (default false). */
  writeProbes?: boolean;
  /** Target network name; MAINNET/PUBLIC/PRODUCTION block write probes. */
  network?: string;
  /** Explicit override allowing write probes on a production network. */
  allowProductionWrites?: boolean;
}

export function isProductionNetwork(network?: string): boolean {
  return /^(mainnet|public|production|prod)$/i.test(network ?? "");
}

/**
 * Runs post-deploy smoke checks against a live contract client.
 * Read-only views always run first; write probes run only when
 * `options.writeProbes` is set and the network is not production.
 */
export async function runSmokeVerification(
  client: ContractClient,
  options: SmokeOptions = {},
): Promise<SmokeResult[]> {
  const results: SmokeResult[] = [];
  let phase: "read" | "write" = "read";

  async function check(label: string, fn: () => Promise<string>): Promise<void> {
    try {
      const detail = await fn();
      results.push({ check: label, passed: true, detail, phase });
    } catch (e: any) {
      results.push({ check: label, passed: false, detail: e.message ?? String(e), phase });
    }
  }

  // Health, version and config views come first so a broken deployment is
  // reported before anything could change state.
  await check("contract is not paused", async () => {
    const paused = await client.isPaused();
    if (paused) throw new Error("contract is paused — check pause reason before routing traffic");
    return "not paused";
  });

  if (client.getVersionInfo) {
    await check("version info is readable", async () => {
      const v = await client.getVersionInfo!();
      return `${v.contract_name} storage_v${v.storage_version}`;
    });
  }

  for (const severity of ["critical", "high", "medium", "low"]) {
    await check(`config[${severity}] has valid threshold`, async () => {
      const cfg = await client.getConfig(severity);
      if (cfg.threshold_minutes <= 0)
        throw new Error(`threshold_minutes=${cfg.threshold_minutes} is invalid`);
      return `threshold=${cfg.threshold_minutes}m`;
    });
  }

  await check("admin address is set", async () => {
    const admin = await client.getAdmin();
    if (!admin) throw new Error("admin address is empty");
    return `admin=${admin.slice(0, 8)}…`;
  });

  await check("operator address is set", async () => {
    const op = await client.getOperator();
    if (!op) throw new Error("operator address is empty");
    return `operator=${op.slice(0, 8)}…`;
  });

  await check("config snapshot is non-empty", async () => {
    const snap = await client.getConfigSnapshot();
    if (!snap.entries || (snap.entries as unknown[]).length === 0)
      throw new Error("config snapshot returned no entries");
    return `version=${snap.version} entries=${(snap.entries as unknown[]).length}`;
  });

  await check("stats are readable", async () => {
    const stats = await client.getStats();
    return `total_calculations=${stats.total_calculations}`;
  });

  // Write probes: opt-in, never against production unless explicitly forced,
  // and never when any read-only check already failed.
  if (options.writeProbes && client.writeProbe) {
    phase = "write";
    if (isProductionNetwork(options.network) && !options.allowProductionWrites) {
      results.push({
        check: "write probe",
        passed: false,
        skipped: true,
        phase,
        detail: `refused: write probes are blocked on production network '${options.network}' (pass allowProductionWrites to override)`,
      });
    } else if (results.some((r) => !r.passed)) {
      results.push({
        check: "write probe",
        passed: false,
        skipped: true,
        phase,
        detail: "skipped: read-only checks failed",
      });
    } else {
      await check("write probe", () => client.writeProbe!());
    }
  }

  return results;
}

// Stub client for local validation
class StubClient implements ContractClient {
  async getAdmin() { return "GADMIN123456"; }
  async getOperator() { return "GOPER123456"; }
  async isPaused() { return false; }
  async getConfig(severity: string) {
    return { threshold_minutes: { critical: 15, high: 30, medium: 60, low: 120 }[severity] ?? 0 };
  }
  async getStats() { return { total_calculations: 42 }; }
  async getConfigSnapshot() { return { version: "v1", entries: [{}, {}, {}, {}] }; }
}

if (require.main === module) {
  (async () => {
    console.log("=== Post-Deploy Smoke Verification ===\n");
    const results = await runSmokeVerification(new StubClient());
    for (const r of results) {
      console.log(`${r.passed ? "✅" : "❌"} ${r.check}: ${r.detail}`);
    }
    const failed = results.filter((r) => !r.passed);
    if (failed.length) {
      console.error(`\n${failed.length} smoke check(s) failed. Do not route traffic.`);
      process.exit(1);
    }
    console.log("\nAll smoke checks passed. Contract deployment healthy.");
  })();
}
