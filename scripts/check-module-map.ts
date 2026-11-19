/**
 * #1050: keeps `docs/contract-module-map.md` aligned with the contract's exported methods.
 *
 * Compares every `pub fn` in the `#[contractimpl]` block of `sla_calculator/src/lib.rs` with the
 * rows of the "Contract Entrypoint Map" table, and reports missing and stale entries by method name.
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/check-module-map.ts
 */
import * as fs from "fs";
import * as path from "path";

export const ENTRYPOINT_SECTION = "## Contract Entrypoint Map";

/** Public methods of the first `#[contractimpl]` block (the block ends at the first `}` in column 0). */
export function extractContractEntrypoints(rustSource: string): string[] {
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
  const names: string[] = [];
  for (const line of lines.slice(start, end)) {
    const m = /^ {4}pub fn ([A-Za-z0-9_]+)\s*[(<]/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

/** Method names in the first column of the entrypoint table: rows that start with "| `name` |". */
export function extractDocumentedEntrypoints(markdown: string): string[] {
  const at = markdown.indexOf(ENTRYPOINT_SECTION);
  if (at === -1) throw new Error(`"${ENTRYPOINT_SECTION}" section not found in the module map`);
  const rest = markdown.slice(at + ENTRYPOINT_SECTION.length);
  const next = rest.search(/\n## /);
  const section = next === -1 ? rest : rest.slice(0, next);
  const names: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\|\s*`([A-Za-z0-9_]+)`\s*\|/.exec(line);
    if (m) names.push(m[1]!);
  }
  return names;
}

export interface ModuleMapDrift {
  /** Exported by the contract but not documented. */
  missing: string[];
  /** Documented but no longer exported by the contract. */
  stale: string[];
  /** Documented more than once. */
  duplicated: string[];
}

export function compareModuleMap(exported: string[], documented: string[]): ModuleMapDrift {
  const exportedSet = new Set(exported);
  const documentedSet = new Set(documented);
  const seen = new Set<string>();
  const duplicated: string[] = [];
  for (const name of documented) {
    if (seen.has(name) && !duplicated.includes(name)) duplicated.push(name);
    seen.add(name);
  }
  return {
    missing: exported.filter((n) => !documentedSet.has(n)),
    stale: documented.filter((n, i) => !exportedSet.has(n) && documented.indexOf(n) === i),
    duplicated,
  };
}

function main(): void {
  const lib = fs.readFileSync(path.resolve(__dirname, "../sla_calculator/src/lib.rs"), "utf8");
  const doc = fs.readFileSync(path.resolve(__dirname, "../docs/contract-module-map.md"), "utf8");
  const drift = compareModuleMap(extractContractEntrypoints(lib), extractDocumentedEntrypoints(doc));
  if (drift.missing.length === 0 && drift.stale.length === 0 && drift.duplicated.length === 0) {
    console.log("Module map lists every exported contract method.");
    return;
  }
  for (const n of drift.missing) console.error(`::error::${n} is exported by lib.rs but missing from docs/contract-module-map.md`);
  for (const n of drift.stale) console.error(`::error::${n} is documented in docs/contract-module-map.md but not exported by lib.rs`);
  for (const n of drift.duplicated) console.error(`::error::${n} is documented more than once in docs/contract-module-map.md`);
  process.exit(1);
}

if (require.main === module) main();
