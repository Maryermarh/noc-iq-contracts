// SC-050: Validates that the repo's documented roadmap matches actual checked-in crates.
// Fails if docs claim a crate exists that isn't present, keeping the roadmap code-accurate.

import * as fs from "fs";
import * as path from "path";

interface CrateEntry {
  name: string;
  status: "active" | "planned";
  dir: string;
}

// Source of truth: what the roadmap claims
const ROADMAP: CrateEntry[] = [
  { name: "sla_calculator",        status: "active",  dir: "sla_calculator" },
  { name: "payment_escrow",        status: "planned", dir: "payment_escrow" },
  { name: "multi_party_settlement",status: "planned", dir: "multi_party_settlement" },
];

const ROOT = path.resolve(__dirname, "..");

export interface StaleLink {
  doc: string;
  line: number;
  link: string;
}

const PATH_RE = /^[\w.\-]+(?:\/[\w.\-]+)+\.(?:rs|ts|sh|md|toml|json|yml|yaml)$/;

/**
 * Finds repo-path references (markdown link targets and backtick-quoted
 * paths) in a document that do not resolve. `exists` is injected so the
 * check can run against a fixture tree. URLs, anchors and globs are ignored.
 */
export function findStaleLinks(
  doc: string,
  text: string,
  exists: (relPath: string) => boolean,
): StaleLink[] {
  const stale: StaleLink[] = [];
  text.split("\n").forEach((lineText, idx) => {
    const candidates: string[] = [];
    for (const m of lineText.matchAll(/\]\(([^)\s]+)\)/g)) candidates.push(m[1]);
    for (const m of lineText.matchAll(/`([^`\s]+)`/g)) candidates.push(m[1]);
    for (const raw of candidates) {
      if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith("#") || raw.startsWith("mailto:")) continue;
      const target = raw.split("#")[0].replace(/^\.\//, "");
      if (!target || /[*?<>{}]/.test(target) || !PATH_RE.test(target)) continue;
      if (!exists(target)) stale.push({ doc, line: idx + 1, link: raw });
    }
  });
  return stale;
}

const ROADMAP_DOCS = ["TODO.md", "TODO_SC006.md", "TODO_SC007.md"];

function validateDocs(): number {
  let errors = 0;
  for (const doc of ROADMAP_DOCS) {
    const file = path.join(ROOT, doc);
    if (!fs.existsSync(file)) continue;
    const stale = findStaleLinks(doc, fs.readFileSync(file, "utf8"), (rel) =>
      fs.existsSync(path.join(ROOT, rel)),
    );
    for (const s of stale) {
      console.error(`[FAIL] ${s.doc}:${s.line} links to missing path '${s.link}'`);
      errors++;
    }
  }
  return errors;
}

function validate(entries: CrateEntry[]): void {
  let errors = validateDocs();

  for (const entry of entries) {
    const exists = fs.existsSync(path.join(ROOT, entry.dir));

    if (entry.status === "active" && !exists) {
      console.error(`[FAIL] '${entry.name}' is marked active but directory '${entry.dir}' not found`);
      errors++;
    }

    if (entry.status === "planned" && exists) {
      console.warn(`[WARN] '${entry.name}' is marked planned but '${entry.dir}' already exists — update status to active`);
    }

    if (entry.status === "active" && exists) {
      console.log(`[ OK] '${entry.name}' — active and present`);
    }

    if (entry.status === "planned" && !exists) {
      console.log(`[ OK] '${entry.name}' — planned, not yet checked in`);
    }
  }

  if (errors) {
    console.error(`\n${errors} roadmap inconsistency(ies) found.`);
    process.exit(1);
  } else {
    console.log("\nRoadmap is consistent with repo state.");
  }
}

if (require.main === module) {
  validate(ROADMAP);
}
