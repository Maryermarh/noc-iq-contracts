// SC-049: Pre-merge security gate for governance and stateful contract changes.
// Scans staged Rust files for common patterns that require manual security sign-off.

import { execSync } from "child_process";
import * as fs from "fs";

interface Rule {
  id: string;
  pattern: RegExp;
  message: string;
}

const RULES: Rule[] = [
  { id: "AUTH-01", pattern: /fn\s+\w+\s*\(.*env.*\)(?![^{]*require_auth)/, message: "Function may be missing require_auth before state write" },
  { id: "STOR-01", pattern: /storage\(\)\.set\(/, message: "Direct storage write — confirm key is namespaced" },
  { id: "GOV-01",  pattern: /set_admin|set_operator/,                       message: "Privileged role change — confirm two-step flow is used" },
  { id: "CFG-01",  pattern: /set_config/,                                   message: "Config mutation — confirm range validation present" },
  { id: "EVT-01",  pattern: /fn\s+\w+\s*\(.*env.*\)(?![^}]*events\(\))/, message: "State-mutating function may be missing event emission" },
];

/** Marker comment placed directly above an intentionally public read-only fn. */
export const READ_ONLY_MARKER = "auth-matrix: read-only";

export interface MutatorFinding {
  method: string;
}

/**
 * Finds exported (`pub fn`) contract functions that mutate state or require
 * auth but have no entry in the authorization matrix. A function is treated
 * as read-only (no matrix entry needed) only when it carries an explicit
 * `// auth-matrix: read-only` marker on the line(s) just above it.
 */
export function findUnmatrixedMutators(rustSrc: string, matrixMethods: Set<string>): string[] {
  const lines = rustSrc.split("\n");
  const starts: { name: string; line: number }[] = [];
  lines.forEach((l, i) => {
    const m = /^\s*pub fn (\w+)\s*[(<]/.exec(l);
    if (m) starts.push({ name: m[1], line: i });
  });
  const missing: string[] = [];
  starts.forEach((fn, idx) => {
    const end = idx + 1 < starts.length ? starts[idx + 1].line : lines.length;
    const body = lines.slice(fn.line, end).join("\n");
    const mutates =
      /\.require_auth\(\)/.test(body) ||
      /storage\(\)[\s\S]*?\.(set|remove)\(/.test(body) ||
      /\bcaller:\s*Address\b/.test(lines[fn.line] + (lines[fn.line + 1] ?? "") + (lines[fn.line + 2] ?? ""));
    if (!mutates) return;
    const above = lines.slice(Math.max(0, fn.line - 3), fn.line).join("\n");
    if (above.includes(READ_ONLY_MARKER)) return;
    if (!matrixMethods.has(fn.name)) missing.push(fn.name);
  });
  return missing;
}

/** Extracts method names from the AUTH_MATRIX fixture in tests/authMatrix.test.ts. */
export function parseMatrixMethods(testSrc: string): Set<string> {
  return new Set([...testSrc.matchAll(/method:\s*"(\w+)"/g)].map((m) => m[1]));
}

function runMatrixGate(): number {
  const lib = fs.readFileSync("sla_calculator/src/lib.rs", "utf8");
  const matrix = parseMatrixMethods(fs.readFileSync("tests/authMatrix.test.ts", "utf8"));
  const missing = findUnmatrixedMutators(lib, matrix);
  if (missing.length) {
    console.error("Mutating entrypoints without an authorization matrix entry:");
    for (const m of missing) console.error(`  - ${m}`);
    console.error(`Add them to tests/authMatrix.test.ts, or mark intentional read-only methods with "// ${READ_ONLY_MARKER}".`);
    return 1;
  }
  console.log("Authorization matrix covers every mutating entrypoint.");
  return 0;
}

function scanFile(path: string): number {
  const src = fs.readFileSync(path, "utf8");
  let hits = 0;
  for (const rule of RULES) {
    if (rule.pattern.test(src)) {
      console.log(`  [${rule.id}] ${path}: ${rule.message}`);
      hits++;
    }
  }
  return hits;
}

function getStagedRustFiles(): string[] {
  try {
    return execSync("git diff --cached --name-only --diff-filter=ACM")
      .toString().trim().split("\n").filter((f) => f.endsWith(".rs"));
  } catch { return []; }
}

if (require.main === module) {
  if (process.argv.includes("--matrix")) process.exit(runMatrixGate());
  const files = getStagedRustFiles();
  if (files.length === 0) { console.log("No staged Rust files — nothing to check."); process.exit(0); }

  console.log(`Scanning ${files.length} staged file(s) for security patterns...\n`);
  const total = files.reduce((n, f) => n + scanFile(f), 0);
  console.log(`\n${total} pattern hit(s) found. Review before merging.`);
  if (total > 0) process.exit(1);
}
