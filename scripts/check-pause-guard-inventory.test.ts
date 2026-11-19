import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  checkInventory,
  extractContractFunctions,
  type PauseGuardInventory,
} from "./check-pause-guard-inventory";

const RUST = `
#[contractimpl]
impl C {
    pub fn do_work(env: Env) {
        Self::require_not_paused(&env)?;
        env.storage().instance().set(&K, &1);
    }
    pub fn pause(env: Env) {
        env.storage().instance().set(&P, &true);
    }
    pub fn peek(env: Env) -> u32 {
        env.storage().instance().get(&K).unwrap_or(0)
    }
}
`;

const inventory = (over: Partial<PauseGuardInventory> = {}): PauseGuardInventory => ({
  guarded: { do_work: { file: "sla_calculator/src/lib.rs", evidence: "Self::require_not_paused(&env)" } },
  exempt: { pause: "pause control" },
  readOnly: ["peek"],
  ...over,
});

const noFiles = () => {
  throw new Error("unexpected file read");
};

describe("#1042 pause-guard inventory", () => {
  it("extracts the exported methods with their bodies", () => {
    const fns = extractContractFunctions(RUST);

    expect(fns.map((f) => f.name)).toEqual(["do_work", "pause", "peek"]);
    expect(fns[0]!.body).toContain("require_not_paused");
    expect(fns[2]!.body).not.toContain("require_not_paused");
  });

  it("passes when every method is classified and the evidence is present", () => {
    expect(checkInventory(extractContractFunctions(RUST), inventory(), noFiles)).toEqual([]);
  });

  it("fails by name for a newly exported mutator that is in no list", () => {
    const withNew = RUST.replace("    pub fn peek", "    pub fn sneaky_write(env: Env) {\n        env.storage().instance().set(&K, &9);\n    }\n    pub fn peek");

    const problems = checkInventory(extractContractFunctions(withNew), inventory(), noFiles);

    expect(problems).toEqual([
      { method: "sneaky_write", problem: expect.stringContaining("not in the pause-guard inventory") },
    ]);
  });

  it("fails by name for a stale entry", () => {
    const problems = checkInventory(extractContractFunctions(RUST), inventory({ readOnly: ["peek", "removed_fn"] }), noFiles);

    expect(problems.map((p) => p.method)).toEqual(["removed_fn"]);
  });

  it("fails when a guarded method no longer contains its pause check", () => {
    const unguarded = RUST.replace("        Self::require_not_paused(&env)?;\n", "");

    const problems = checkInventory(extractContractFunctions(unguarded), inventory(), noFiles);

    expect(problems).toEqual([{ method: "do_work", problem: expect.stringContaining("marked guarded") }]);
  });

  it("verifies evidence that lives in another file", () => {
    const inv = inventory({
      guarded: { do_work: { file: "sla_calculator/src/batch.rs", evidence: 'symbol_short!("PAUSED")' } },
    });

    const ok = checkInventory(extractContractFunctions(RUST), inv, () => 'let p = env.get(&symbol_short!("PAUSED"));');
    const bad = checkInventory(extractContractFunctions(RUST), inv, () => "no check here");

    expect(ok).toEqual([]);
    expect(bad.map((p) => p.method)).toEqual(["do_work"]);
  });

  it("fails when a method is classified twice", () => {
    const problems = checkInventory(extractContractFunctions(RUST), inventory({ readOnly: ["peek", "pause"] }), noFiles);

    expect(problems.some((p) => p.method === "pause" && p.problem.includes("more than once"))).toBe(true);
  });

  it("fails when a readOnly method starts writing", () => {
    const writes = RUST.replace("env.storage().instance().get(&K).unwrap_or(0)", "env.storage().instance().set(&K, &2); 0");

    const problems = checkInventory(extractContractFunctions(writes), inventory(), noFiles);

    expect(problems).toEqual([{ method: "peek", problem: expect.stringContaining("marked readOnly") }]);
  });

  it("fails an exempt entry that has no reason", () => {
    const problems = checkInventory(extractContractFunctions(RUST), inventory({ exempt: { pause: " " } }), noFiles);

    expect(problems).toEqual([{ method: "pause", problem: "exempt without a reason" }]);
  });

  it("the real inventory covers the real contract", () => {
    const root = path.resolve(__dirname, "..");
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
    const real = JSON.parse(read("scripts/pause-guard-inventory.json")) as PauseGuardInventory;

    expect(checkInventory(extractContractFunctions(read("sla_calculator/src/lib.rs")), real, read)).toEqual([]);
  });
});
