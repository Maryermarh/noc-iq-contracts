import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const root = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const constant = (source: string, name: string): number => {
  const m = new RegExp(`const ${name}: u32 = (\\d+);`).exec(source);
  if (!m) throw new Error(`${name} not found`);
  return Number(m[1]);
};

const fixture = JSON.parse(read("artifacts/version-discovery.json")) as {
  contract_version: number;
  storage_version: number;
};

describe("#1046 version discovery fixture", () => {
  it("lists both the contract version and the storage schema version", () => {
    expect(Object.keys(fixture).sort()).toEqual(["contract_version", "storage_version"]);
  });

  it("matches the constants version_discovery.rs reports", () => {
    const discovery = read("sla_calculator/src/version_discovery.rs");

    expect(fixture.contract_version).toBe(constant(discovery, "PROTOCOL_VERSION"));
    expect(fixture.storage_version).toBe(constant(discovery, "STORAGE_VERSION"));
  });

  it("agrees with the storage version the contract enforces", () => {
    expect(fixture.storage_version).toBe(constant(read("sla_calculator/src/lib.rs"), "STORAGE_VERSION"));
    expect(fixture.storage_version).toBe(constant(read("sla_calculator/src/storage_version.rs"), "EXPECTED_STORAGE_VERSION"));
  });

  it("the docs state the same storage schema version", () => {
    const doc = read("docs/schema-evolution.md");

    expect(doc).toContain(`| Storage schema (\`STORAGE_VERSION\`) | \`${fixture.storage_version}\``);
  });
});
