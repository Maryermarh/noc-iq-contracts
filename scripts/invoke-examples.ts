/**
 * SC-036: Executable invocation examples for the current contract surface.
 * Covers governance flows and parity-oriented read flows.
 */

import { execSync } from "child_process";

const CONTRACT_ID = process.env.CONTRACT_ID ?? "<contract-id>";
const SOURCE = process.env.SOURCE_ACCOUNT ?? "<source-account>";
const NETWORK = process.env.NETWORK ?? "testnet";

const SECRET_SEED = /\bS[A-Z2-7]{55}\b/g;
const SECRET_ASSIGN =
  /((?:secret|private|seed|mnemonic|passphrase|password|token|api[_-]?key)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const SECRET_FLAG =
  /(--(?:source-account|source|secret-key|private-key|sign-with-key)(?:\s+|=))(\S+)/g;

/**
 * Removes secret-like material from text before it is logged: Stellar secret
 * seeds (S...), the configured SOURCE_ACCOUNT when it is a secret, values of
 * secret-looking assignments, and --source-account style flag values.
 * Public keys, contract IDs, network and function names are left intact.
 */
export function redactSecrets(text: string, configuredSecret?: string): string {
  let out = text;
  if (configuredSecret && configuredSecret.length >= 8) {
    out = out.split(configuredSecret).join("[REDACTED]");
  }
  return out
    .replace(SECRET_SEED, "[REDACTED]")
    .replace(SECRET_FLAG, (_m, flag: string, value: string) =>
      /^G[A-Z2-7]{55}$/.test(value) ? `${flag}${value}` : `${flag}[REDACTED]`,
    )
    .replace(SECRET_ASSIGN, "$1[REDACTED]");
}

export function buildCommand(
  fn: string,
  args: Record<string, string> = {},
  env: { contractId: string; source: string; network: string } = {
    contractId: CONTRACT_ID,
    source: SOURCE,
    network: NETWORK,
  },
): string {
  const flags = Object.entries(args)
    .map(([k, v]) => `--${k} ${v}`)
    .join(" ");
  return `soroban contract invoke --id ${env.contractId} --source-account ${env.source} --network ${env.network} -- ${fn} ${flags}`;
}

/** Sanitized failure text that still names the function, network and contract. */
export function formatFailure(fn: string, rawError: string, network = NETWORK, contractId = CONTRACT_ID): string {
  return `[invoke failed] fn=${fn} network=${network} contract=${contractId}: ${redactSecrets(rawError, SOURCE)}`;
}

function invoke(fn: string, args: Record<string, string> = {}): string {
  const cmd = buildCommand(fn, args);
  console.log(`\n$ ${redactSecrets(cmd, SOURCE)}`);
  try {
    return execSync(cmd, { encoding: "utf8" });
  } catch (e: any) {
    return formatFailure(fn, `${e.stderr ?? ""}${e.stderr ? "" : String(e)}`);
  }
}

// --- Read flows (parity-oriented) ---
function readExamples() {
  console.log("=== Config snapshot ===");
  console.log(invoke("get_config_snapshot"));

  console.log("=== Stats ===");
  console.log(invoke("get_stats"));

  console.log("=== Result schema ===");
  console.log(invoke("get_result_schema"));

  console.log("=== SLA view (critical, 30 min MTTR) ===");
  console.log(invoke("calculate_sla_view", { severity: "critical", mttr_minutes: "30" }));
}

// --- Governance flows ---
function governanceExamples(newAdmin: string, newOperator: string) {
  console.log("=== Propose admin ===");
  console.log(invoke("propose_admin", { caller: SOURCE, new_admin: newAdmin }));

  console.log("=== Pending admin ===");
  console.log(invoke("get_pending_admin"));

  console.log("=== Propose operator ===");
  console.log(invoke("propose_operator", { caller: SOURCE, new_operator: newOperator }));

  console.log("=== Pending operator ===");
  console.log(invoke("get_pending_operator"));
}

const [, , mode, arg1 = "", arg2 = ""] = process.argv;
if (require.main !== module) {
  // imported for tests
} else if (mode === "read") readExamples();
else if (mode === "governance") governanceExamples(arg1, arg2);
else console.log("Usage: ts-node invoke-examples.ts <read|governance> [newAdmin] [newOperator]");
