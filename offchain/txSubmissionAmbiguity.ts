/**
 * SC-W5-111: Transaction submission ambiguity handling guidance and tests.
 *
 * Stellar transaction submission can return ambiguous outcomes (TIMEOUT,
 * connection drop, etc.) where the backend cannot tell if the tx landed.
 * This module defines safe re-submission semantics and tests for the contract
 * to remain idempotent under such conditions.
 */

export type TxStatus = "success" | "failed" | "timeout" | "unknown";

export interface TxSubmissionResult {
  tx_hash: string;
  status: TxStatus;
  ledger_sequence?: number;
}

export interface AmbiguityResolution {
  safe_to_retry: boolean;
  action: "retry" | "query_only" | "abort";
  reason: string;
}

/**
 * Given a submission result, returns the safe action for the backend.
 * Contract state must never be double-applied; query first on ambiguous outcomes.
 */
export function resolveAmbiguity(result: TxSubmissionResult): AmbiguityResolution {
  switch (result.status) {
    case "success":
      return { safe_to_retry: false, action: "query_only", reason: "tx confirmed; query state to verify" };
    case "failed":
      return { safe_to_retry: true, action: "retry", reason: "tx definitively failed; safe to resubmit" };
    case "timeout":
      return { safe_to_retry: false, action: "query_only", reason: "timeout: tx may have landed; query before retry" };
    case "unknown":
      return { safe_to_retry: false, action: "query_only", reason: "unknown outcome: query ledger state first" };
  }
}

// ---------------------------------------------------------------------------
// #1067: deadline-bounded status polling
// ---------------------------------------------------------------------------

export interface PollDeadlineOptions {
  /** Hash of the ambiguous submission to look up. */
  tx_hash: string;
  /** Caller deadline: no lookup starts at or after `started_at + deadline_ms`. */
  deadline_ms: number;
  /** Pause between lookups. */
  interval_ms: number;
  /** Looks the transaction up; the result is classified like a submission result. */
  lookup: (tx_hash: string) => Promise<TxStatus>;
  /** Injectable clock (ms); defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface PollDeadlineResult {
  tx_hash: string;
  /** `unknown` means the deadline expired with the transaction still unconfirmed. */
  status: "success" | "failed" | "unknown";
  lookups: number;
  elapsed_ms: number;
  resolution: AmbiguityResolution;
}

/**
 * Polls an ambiguous submission until it is confirmed, definitively failed, or the caller's
 * deadline passes. No lookup is started once the deadline has been reached, and an expired
 * deadline yields the final state `unknown` (query-only), never `failed`: an unconfirmed
 * transaction may still land, so it must not become safe to resubmit.
 */
export async function pollUntilDeadline(opts: PollDeadlineOptions): Promise<PollDeadlineResult> {
  if (!opts.tx_hash) throw new Error("[SC-W5-111] tx_hash must not be empty");
  if (!(opts.deadline_ms > 0) || !(opts.interval_ms > 0)) {
    throw new Error("[SC-W5-111] deadline_ms and interval_ms must be positive");
  }
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const deadline = startedAt + opts.deadline_ms;
  let lookups = 0;

  const finish = (status: PollDeadlineResult["status"]): PollDeadlineResult => ({
    tx_hash: opts.tx_hash,
    status,
    lookups,
    elapsed_ms: now() - startedAt,
    resolution: resolveAmbiguity({ tx_hash: opts.tx_hash, status }),
  });

  for (;;) {
    if (now() >= deadline) return finish("unknown");
    lookups += 1;
    const observed = await opts.lookup(opts.tx_hash);
    if (observed === "success") return finish("success");
    if (observed === "failed") return finish("failed");
    const remaining = deadline - now();
    if (remaining <= 0) return finish("unknown");
    await sleep(Math.min(opts.interval_ms, remaining));
  }
}

interface AmbiguityCase {
  label: string;
  result: TxSubmissionResult;
  expected_action: AmbiguityResolution["action"];
  expected_safe_to_retry: boolean;
}

const cases: AmbiguityCase[] = [
  {
    label: "confirmed success is not retried",
    result: { tx_hash: "HASH1", status: "success", ledger_sequence: 1000 },
    expected_action: "query_only",
    expected_safe_to_retry: false,
  },
  {
    label: "definitive failure allows retry",
    result: { tx_hash: "HASH2", status: "failed" },
    expected_action: "retry",
    expected_safe_to_retry: true,
  },
  {
    label: "timeout requires query first",
    result: { tx_hash: "HASH3", status: "timeout" },
    expected_action: "query_only",
    expected_safe_to_retry: false,
  },
  {
    label: "unknown requires query first",
    result: { tx_hash: "HASH4", status: "unknown" },
    expected_action: "query_only",
    expected_safe_to_retry: false,
  },
];

// Adversarial: empty tx_hash must be flagged
function assertValidTxHash(result: TxSubmissionResult): void {
  if (!result.tx_hash) throw new Error("[SC-W5-111] tx_hash must not be empty");
}

function runTests(): void {
  console.log("[SC-W5-111] Transaction submission ambiguity tests\n");
  for (const c of cases) {
    assertValidTxHash(c.result);
    const resolution = resolveAmbiguity(c.result);
    if (resolution.action !== c.expected_action)
      throw new Error(`"${c.label}": action expected ${c.expected_action}, got ${resolution.action}`);
    if (resolution.safe_to_retry !== c.expected_safe_to_retry)
      throw new Error(`"${c.label}": safe_to_retry mismatch`);
    console.log(`  ✓ ${c.label}`);
  }

  // Adversarial: empty hash rejected
  try {
    assertValidTxHash({ tx_hash: "", status: "success" });
    throw new Error("Should have thrown");
  } catch (e: any) {
    if (!e.message.includes("SC-W5-111")) throw e;
    console.log("  ✓ adversarial: empty tx_hash rejected");
  }

  console.log(`\nAll ambiguity handling tests passed.`);
}

/** Fake clock whose `sleep` advances time, so the deadline tests need no real timers. */
function fakeClock(start = 1_000) {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

async function runDeadlineTests(): Promise<void> {
  console.log("\n[SC-W5-111 / #1067] Deadline-bounded polling tests\n");

  // Confirms before the deadline.
  {
    const clock = fakeClock();
    const statuses: TxStatus[] = ["unknown", "timeout", "success"];
    let i = 0;
    const r = await pollUntilDeadline({
      tx_hash: "HASH", deadline_ms: 10_000, interval_ms: 1_000, now: clock.now, sleep: clock.sleep,
      lookup: async () => statuses[i++]!,
    });
    if (r.status !== "success" || r.lookups !== 3) throw new Error("Expected success after 3 lookups");
    console.log("  ✓ confirmation before the deadline is returned");
  }

  // A definitive failure is reported as failed.
  {
    const clock = fakeClock();
    const r = await pollUntilDeadline({
      tx_hash: "HASH", deadline_ms: 10_000, interval_ms: 1_000, now: clock.now, sleep: clock.sleep,
      lookup: async () => "failed",
    });
    if (r.status !== "failed" || !r.resolution.safe_to_retry) throw new Error("Expected failed + retryable");
    console.log("  ✓ definitive failure is reported as failed");
  }

  // No request starts after the deadline, and the final state is unknown, not failed.
  {
    const clock = fakeClock();
    const startedAt = clock.now();
    const lookupTimes: number[] = [];
    const r = await pollUntilDeadline({
      tx_hash: "HASH", deadline_ms: 5_000, interval_ms: 2_000, now: clock.now, sleep: clock.sleep,
      lookup: async () => { lookupTimes.push(clock.now()); return "timeout"; },
    });
    if (lookupTimes.some((t) => t >= startedAt + 5_000)) throw new Error("A lookup started after the deadline");
    if (r.status !== "unknown") throw new Error(`Expected unknown at deadline, got ${r.status}`);
    if (r.resolution.safe_to_retry || r.resolution.action !== "query_only") throw new Error("unknown must stay query_only");
    console.log("  ✓ no lookup starts after the deadline; expiry yields unknown, not failed");
  }

  // A slow lookup that crosses the deadline ends polling without another request.
  {
    const clock = fakeClock();
    let calls = 0;
    const r = await pollUntilDeadline({
      tx_hash: "HASH", deadline_ms: 3_000, interval_ms: 1_000, now: clock.now, sleep: clock.sleep,
      lookup: async () => { calls += 1; clock.advance(4_000); return "unknown"; },
    });
    if (calls !== 1 || r.status !== "unknown") throw new Error("Expected exactly one lookup then unknown");
    console.log("  ✓ a lookup that overruns the deadline is the last one");
  }

  // A deadline that is already past never looks up.
  {
    const clock = fakeClock();
    let calls = 0;
    const r = await pollUntilDeadline({
      tx_hash: "HASH", deadline_ms: 1, interval_ms: 1, now: () => { clock.advance(1); return clock.now(); },
      sleep: clock.sleep, lookup: async () => { calls += 1; return "success"; },
    });
    if (calls !== 0 || r.status !== "unknown") throw new Error("Expected no lookups after an expired deadline");
    console.log("  ✓ an expired deadline performs no lookups");
  }

  // Adversarial inputs.
  for (const bad of [{ tx_hash: "" }, { deadline_ms: 0 }, { interval_ms: -1 }]) {
    try {
      await pollUntilDeadline({ tx_hash: "H", deadline_ms: 1_000, interval_ms: 100, lookup: async () => "success", ...bad });
      throw new Error("Should have thrown");
    } catch (e: any) {
      if (!e.message.includes("SC-W5-111")) throw e;
    }
  }
  console.log("  ✓ adversarial: empty hash and non-positive deadline/interval rejected");

  console.log("\nAll deadline polling tests passed.");
}

runTests();
runDeadlineTests().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
