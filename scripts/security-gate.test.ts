import { describe, it, expect } from "vitest";
import { findUnmatrixedMutators, parseMatrixMethods } from "./security-gate";

const src = `
impl C {
    pub fn pause(env: Env, caller: Address) -> Result<(), E> {
        caller.require_auth();
        env.storage().instance().set(&K, &1);
        Ok(())
    }

    pub fn brand_new_mutator(env: Env, caller: Address) -> Result<(), E> {
        caller.require_auth();
        env.storage().instance().set(&K, &2);
        Ok(())
    }

    // auth-matrix: read-only
    pub fn get_stats(env: Env) -> Stats {
        env.storage().instance().get(&K).unwrap()
    }

    pub fn is_paused(env: Env) -> bool {
        false
    }
}
`;

describe("findUnmatrixedMutators", () => {
  it("flags a new mutator that is missing from the matrix", () => {
    expect(findUnmatrixedMutators(src, new Set(["pause"]))).toEqual(["brand_new_mutator"]);
  });

  it("does not flag matrixed mutators, marked read-only or plain views", () => {
    expect(findUnmatrixedMutators(src, new Set(["pause", "brand_new_mutator"]))).toEqual([]);
  });

  it("treats a marked method as read-only even if it touches storage", () => {
    const marked = `    // auth-matrix: read-only\n    pub fn warm_cache(env: Env) {\n        env.storage().instance().set(&K, &1);\n    }\n`;
    expect(findUnmatrixedMutators(marked, new Set())).toEqual([]);
  });
});

describe("parseMatrixMethods", () => {
  it("extracts method names from the fixture", () => {
    const set = parseMatrixMethods('{ method: "pause", requiredRole: "admin" },\n{ method: "set_config", x: 1 }');
    expect([...set].sort()).toEqual(["pause", "set_config"]);
  });
});
