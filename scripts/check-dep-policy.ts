/**
 * SC-041: SDK compatibility and dependency update policy enforcer.
 * Reads Cargo.toml and validates pinned versions against policy rules.
 */

import * as fs from "fs";
import * as path from "path";

interface Policy {
  minSorobanSdk: string;
  minRustEdition: string;
  requirePinnedVersions: boolean;
}

const DEFAULT_POLICY: Policy = {
  minSorobanSdk: "21.0.0",
  minRustEdition: "2021",
  requirePinnedVersions: true,
};

function parseCargoToml(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, "utf8");
  const deps: Record<string, string> = {};
  const depSection = /\[dependencies\]([\s\S]*?)(\[|$)/.exec(content)?.[1] ?? "";
  for (const line of depSection.split("\n")) {
    const m = /^(\S+)\s*=\s*"([^"]+)"/.exec(line.trim());
    if (m) deps[m[1]] = m[2];
  }
  const editionMatch = /edition\s*=\s*"(\d+)"/.exec(content);
  if (editionMatch) deps["__edition__"] = editionMatch[1];
  return deps;
}

function semverAtLeast(actual: string, min: string): boolean {
  const parse = (v: string) => v.replace(/[^0-9.]/g, "").split(".").map(Number);
  const [a, b] = [parse(actual), parse(min)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

export interface DepException {
  advisory: string;
  package: string;
  /** ISO date (YYYY-MM-DD); the exception is valid through the end of that day (UTC). */
  expires: string;
  rationale: string;
}

export interface ExceptionVerdict {
  valid: DepException[];
  errors: string[];
}

/**
 * Validates dependency/advisory exceptions. An exception must name one exact
 * advisory and one exact package that is actually in the dependency set, have
 * a rationale and a future expiry. Wildcards, expired entries and
 * package-mismatched entries are all errors.
 */
export function validateExceptions(
  exceptions: DepException[],
  knownPackages: Set<string>,
  now: Date = new Date(),
): ExceptionVerdict {
  const valid: DepException[] = [];
  const errors: string[] = [];
  for (const e of exceptions) {
    const id = `${e.advisory ?? "?"} / ${e.package ?? "?"}`;
    const problems: string[] = [];
    if (!e.advisory || /[*?]/.test(e.advisory)) problems.push("advisory must be an exact ID (no wildcards)");
    if (!e.package || /[*?]/.test(e.package)) problems.push("package must be an exact name (no wildcards)");
    if (e.package && !/[*?]/.test(e.package) && !knownPackages.has(e.package)) {
      problems.push(`package '${e.package}' is not in the dependency set`);
    }
    if (!e.rationale || !e.rationale.trim()) problems.push("rationale is required");
    const expiry = /^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? "")
      ? new Date(`${e.expires}T23:59:59.999Z`)
      : null;
    if (!expiry || Number.isNaN(expiry.getTime())) {
      problems.push("expires must be a YYYY-MM-DD date");
    } else if (expiry.getTime() < now.getTime()) {
      problems.push(`expired on ${e.expires}`);
    }
    if (problems.length) errors.push(`${id}: ${problems.join("; ")}`);
    else valid.push(e);
  }
  return { valid, errors };
}

/** Package names listed in Cargo.lock text. */
export function lockPackages(lockText: string): Set<string> {
  return new Set([...lockText.matchAll(/^name = "([^"]+)"/gm)].map((m) => m[1]));
}

function checkExceptions(exceptionsPath: string, lockPath: string): boolean {
  if (!fs.existsSync(exceptionsPath)) return true;
  const exceptions = JSON.parse(fs.readFileSync(exceptionsPath, "utf8")) as DepException[];
  const known = fs.existsSync(lockPath)
    ? lockPackages(fs.readFileSync(lockPath, "utf8"))
    : new Set<string>();
  const { valid, errors } = validateExceptions(exceptions, known);
  for (const e of valid) {
    console.log(`✅ exception ${e.advisory} for ${e.package}: expires ${e.expires} — ${e.rationale}`);
  }
  for (const err of errors) console.error(`❌ invalid exception ${err}`);
  return errors.length === 0;
}

function checkPolicy(cargoPath: string, policy: Policy = DEFAULT_POLICY): boolean {
  const deps = parseCargoToml(cargoPath);
  let ok = true;

  const sdkVer = deps["soroban-sdk"] ?? "0";
  if (!semverAtLeast(sdkVer, policy.minSorobanSdk)) {
    console.error(`❌ soroban-sdk ${sdkVer} < required ${policy.minSorobanSdk}`);
    ok = false;
  } else {
    console.log(`✅ soroban-sdk ${sdkVer} meets minimum ${policy.minSorobanSdk}`);
  }

  if (policy.requirePinnedVersions) {
    const unpinned = Object.entries(deps).filter(([k, v]) => k !== "__edition__" && /[\^~*]/.test(v));
    if (unpinned.length) {
      console.error(`❌ Unpinned deps: ${unpinned.map(([k]) => k).join(", ")}`);
      ok = false;
    } else {
      console.log("✅ All dependencies are pinned");
    }
  }

  return ok;
}

if (require.main === module) {
  const cargoPath = path.resolve(process.argv[2] ?? "sla_calculator/Cargo.toml");
  const exceptionsOk = checkExceptions(
    path.resolve("dep-policy-exceptions.json"),
    path.resolve("Cargo.lock"),
  );
  const passed = checkPolicy(cargoPath) && exceptionsOk;
  process.exit(passed ? 0 : 1);
}
