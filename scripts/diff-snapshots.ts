// SC-048: Classify snapshot diffs as expected or suspicious for PR review guidance.
// Reads two snapshot files and reports which changed fields are semantic vs volatile.

import * as fs from "fs";

const VOLATILE = new Set(["timestamp", "generated_at", "elapsed_ms", "run_id"]);

export type JsonVal = string | number | boolean | null | JsonVal[] | { [k: string]: JsonVal };

export function flatten(obj: JsonVal, prefix = ""): Record<string, JsonVal> {
  if (obj === null || typeof obj !== "object") return { [prefix]: obj };
  if (Array.isArray(obj)) {
    return obj.reduce<Record<string, JsonVal>>((acc, v, i) => {
      Object.assign(acc, flatten(v as JsonVal, `${prefix}[${i}]`));
      return acc;
    }, {});
  }
  return Object.entries(obj).reduce<Record<string, JsonVal>>((acc, [k, v]) => {
    Object.assign(acc, flatten(v as JsonVal, prefix ? `${prefix}.${k}` : k));
    return acc;
  }, {});
}

export interface DiffClassification {
  semanticChanges: { key: string; before: JsonVal; after: JsonVal }[];
  volatileChanges: string[];
}

/**
 * Classifies every changed leaf key between two already-parsed JSON
 * snapshots as either "volatile" (known-noisy fields like timestamps) or
 * "semantic" (a real change worth reviewing).
 */
export function classifyDiff(before: JsonVal, after: JsonVal): DiffClassification {
  const a = flatten(before);
  const b = flatten(after);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const semanticChanges: { key: string; before: JsonVal; after: JsonVal }[] = [];
  const volatileChanges: string[] = [];

  for (const k of keys) {
    if (a[k] === b[k]) continue;
    const leaf = k.split(".").pop() ?? k;
    if (VOLATILE.has(leaf)) {
      volatileChanges.push(k);
    } else {
      semanticChanges.push({ key: k, before: a[k], after: b[k] });
    }
  }

  return { semanticChanges, volatileChanges };
}

/** Expected snapshot names that are absent from `present`. */
export function findMissingSnapshots(expected: string[], present: Set<string>): string[] {
  return expected.filter((name) => !present.has(name)).sort();
}

/**
 * Minimal line-based unified diff (single hunk with full context) so an
 * intentional fixture update is reviewable. Returns "" when equal.
 */
export function unifiedDiff(before: string, after: string, labelA = "before", labelB = "after"): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  // LCS table
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [`--- ${labelA}`, `+++ ${labelB}`, `@@ -1,${a.length} +1,${b.length} @@`];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i++]}`);
    } else {
      out.push(`+${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join("\n") + "\n";
}

function classify(beforePath: string, afterPath: string): void {
  const missing = [beforePath, afterPath].filter((f) => !fs.existsSync(f));
  if (missing.length) {
    console.error(`Missing snapshot(s):\n${missing.map((m) => `  - ${m}`).join("\n")}`);
    console.error("A missing snapshot is not 'no difference'. Generate it, or pass the right path.");
    process.exit(1);
  }
  const rawA = fs.readFileSync(beforePath, "utf8");
  const rawB = fs.readFileSync(afterPath, "utf8");
  const a = JSON.parse(rawA);
  const b = JSON.parse(rawB);
  const diffText = unifiedDiff(rawA, rawB, beforePath, afterPath);
  if (diffText) console.log(diffText);
  const { semanticChanges, volatileChanges } = classifyDiff(a, b);

  for (const change of volatileChanges) {
    console.log(`  [volatile]  ${change}`);
  }
  for (const change of semanticChanges) {
    console.log(
      `  [SEMANTIC]  ${change.key}  ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`,
    );
  }

  console.log(
    `\n${semanticChanges.length} semantic change(s), ${volatileChanges.length} volatile change(s).`,
  );
  if (semanticChanges.length === 0 && volatileChanges.length > 0) {
    console.log("Verdict: noise-only diff — safe to ignore.");
  } else if (semanticChanges.length > 0) {
    console.log("Verdict: real change detected — review required.");
  }
}

if (require.main === module) {
  const [, , before, after] = process.argv;
  if (before === "--require-dir") {
    // --require-dir <dir> <name>... : every named snapshot must exist in <dir>
    const dir = after;
    const names = process.argv.slice(4);
    if (!dir || names.length === 0) {
      console.error("Usage: diff-snapshots.ts --require-dir <dir> <snapshot-name>...");
      process.exit(1);
    }
    const present = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    const missing = findMissingSnapshots(names, present);
    if (missing.length) {
      console.error(`Missing expected snapshots in ${dir}:\n${missing.map((m) => `  - ${m}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`All ${names.length} expected snapshot(s) present.`);
    process.exit(0);
  }
  if (!before || !after) {
    console.error("Usage: ts-node diff-snapshots.ts <before.json> <after.json>");
    process.exit(1);
  }
  classify(before, after);
}
