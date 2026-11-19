/**
 * #1042: inventory check for the pause guard.
 *
 * Every method exported by the contract must be classified in `scripts/pause-guard-inventory.json`
 * as exactly one of:
 *   - `guarded`:  must refuse to run while the contract is paused (evidence of the check is verified),
 *   - `exempt`:   mutates state but is deliberately allowed while paused (with the reason),
 *   - `readOnly`: does not write storage or emit events.
 *
 * A newly exported method that is in none of them fails the check, by name, so a future mutator
 * cannot silently bypass the pause guard because it was left off a manual list.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/check-pause-guard-inventory.ts
 */
import * as fs from "fs";
import * as path from "path";

export interface GuardedEntry {
  /** File that holds the pause check for this method. */
  file: string;
  /** Text that must appear in that check's code. */
  evidence: string;
}

export interface PauseGuardInventory {
  guarded: Record<string, GuardedEntry>;
  exempt: Record<string, string>;
  readOnly: string[];
}

export interface ContractFunction {
  name: string;
  body: string;
}

const LIB_RS = "sla_calculator/src/lib.rs";

/** Public methods, with their source, from the first `#[contractimpl]` block of lib.rs. */
export function extractContractFunctions(rustSource: string): ContractFunction[] {
  const lines = rustSource.split("\n");
  const start = lines.findIndex((l) => l.trim() === "#[contractimpl]");
  if (start === -1) throw new Error("#[contractimpl] block not found in lib.rs");
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  const heads: Array<{ name: string; at: number }> = [];
  block.forEach((line, i) => {
    const m = /^ {4}pub fn ([A-Za-z0-9_]+)\s*[(<]/.exec(line);
    if (m) heads.push({ name: m[1]!, at: i });
  });
  return heads.map((h, k) => ({
    name: h.name,
    body: block.slice(h.at, k + 1 < heads.length ? heads[k + 1]!.at : block.length).join("\n"),
  }));
}

const WRITES = /\.set\(|\.remove\(|\.publish\(|extend_ttl\(/;

export interface InventoryProblem {
  method: string;
  problem: string;
}

/**
 * Checks the inventory against the contract. `readFile` resolves a repo-relative path to its text
 * (used to verify the evidence of `guarded` entries that live outside lib.rs).
 */
export function checkInventory(
  functions: ContractFunction[],
  inventory: PauseGuardInventory,
  readFile: (relativePath: string) => string
): InventoryProblem[] {
  const problems: InventoryProblem[] = [];
  const exported = new Map(functions.map((f) => [f.name, f.body]));
  const classified = new Map<string, string[]>();
  const note = (name: string, list: string) => classified.set(name, [...(classified.get(name) ?? []), list]);

  Object.keys(inventory.guarded).forEach((n) => note(n, "guarded"));
  Object.keys(inventory.exempt).forEach((n) => note(n, "exempt"));
  inventory.readOnly.forEach((n) => note(n, "readOnly"));

  for (const f of functions) {
    if (!classified.has(f.name)) {
      problems.push({ method: f.name, problem: "exported but not in the pause-guard inventory (add it to guarded, exempt or readOnly)" });
    }
  }
  for (const [name, lists] of classified) {
    if (!exported.has(name)) problems.push({ method: name, problem: `listed in ${lists.join(", ")} but no longer exported` });
    if (lists.length > 1) problems.push({ method: name, problem: `listed more than once (${lists.join(", ")})` });
  }
  for (const [name, entry] of Object.entries(inventory.guarded)) {
    const body = exported.get(name);
    if (body === undefined) continue;
    const text = entry.file === LIB_RS ? body : readFile(entry.file);
    if (!text.includes(entry.evidence)) {
      problems.push({ method: name, problem: `marked guarded but ${entry.file} does not contain "${entry.evidence}"` });
    }
  }
  for (const [name, reason] of Object.entries(inventory.exempt)) {
    if (exported.has(name) && reason.trim() === "") problems.push({ method: name, problem: "exempt without a reason" });
  }
  for (const name of inventory.readOnly) {
    const body = exported.get(name);
    if (body !== undefined && WRITES.test(body)) {
      problems.push({ method: name, problem: "marked readOnly but its body writes storage or emits events" });
    }
  }
  return problems;
}

function main(): void {
  const root = path.resolve(__dirname, "..");
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
  const inventory = JSON.parse(read("scripts/pause-guard-inventory.json")) as PauseGuardInventory;
  const problems = checkInventory(extractContractFunctions(read(LIB_RS)), inventory, read);
  if (problems.length === 0) {
    console.log("Pause-guard inventory covers every exported contract method.");
    return;
  }
  for (const p of problems) console.error(`::error::${p.method}: ${p.problem}`);
  process.exit(1);
}

if (require.main === module) main();
