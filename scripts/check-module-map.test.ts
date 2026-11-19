import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  compareModuleMap,
  extractContractEntrypoints,
  extractDocumentedEntrypoints,
} from "./check-module-map";

const RUST = `
#[contract]
pub struct C;

#[contractimpl]
impl C {
    pub fn initialize(env: Env) {}
    fn private_helper(env: &Env) {}
    pub fn get_admin(env: Env) -> u32 { 1 }
    /// docs
    pub fn generic_one<T>(env: Env) {}
}

impl C {
    pub fn not_exported(env: Env) {}
}
`;

const DOC = `
# Map

## Contract Entrypoint Map

| Method | Where | Access |
|--------|-------|--------|
| \`initialize\` | lib.rs | once |
| \`get_admin\` | lib.rs | public |

## Next section

| \`unrelated\` | x | y |
`;

describe("#1050 module map check", () => {
  it("extracts only public methods of the contractimpl block", () => {
    expect(extractContractEntrypoints(RUST)).toEqual(["initialize", "get_admin", "generic_one"]);
  });

  it("extracts documented methods from the entrypoint section only", () => {
    expect(extractDocumentedEntrypoints(DOC)).toEqual(["initialize", "get_admin"]);
  });

  it("reports a missing and a stale entry by name", () => {
    const drift = compareModuleMap(["a", "b", "c"], ["a", "gone", "c"]);

    expect(drift.missing).toEqual(["b"]);
    expect(drift.stale).toEqual(["gone"]);
    expect(drift.duplicated).toEqual([]);
  });

  it("reports duplicated rows once", () => {
    expect(compareModuleMap(["a"], ["a", "a", "a"]).duplicated).toEqual(["a"]);
  });

  it("is clean when both sides agree", () => {
    expect(compareModuleMap(["a", "b"], ["b", "a"])).toEqual({ missing: [], stale: [], duplicated: [] });
  });

  it("fails loudly when the section or the contractimpl block is absent", () => {
    expect(() => extractDocumentedEntrypoints("# nothing")).toThrow(/section not found/);
    expect(() => extractContractEntrypoints("fn main() {}")).toThrow(/#\[contractimpl\]/);
  });

  it("the real module map documents every exported method of the real contract", () => {
    const lib = fs.readFileSync(path.resolve(__dirname, "../sla_calculator/src/lib.rs"), "utf8");
    const doc = fs.readFileSync(path.resolve(__dirname, "../docs/contract-module-map.md"), "utf8");

    const drift = compareModuleMap(extractContractEntrypoints(lib), extractDocumentedEntrypoints(doc));

    expect(drift).toEqual({ missing: [], stale: [], duplicated: [] });
  });
});
