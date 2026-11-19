import { describe, it, expect } from "vitest";
import { evaluateSize, BUILD_COMMAND } from "./check-wasm-size";

describe("evaluateSize", () => {
  it("passes exactly at the budget boundary", () => {
    expect(evaluateSize(65536, 65536).ok).toBe(true);
  });

  it("fails one byte over the budget", () => {
    const v = evaluateSize(65537, 65536);
    expect(v.ok).toBe(false);
    expect(v.message).toContain("over by 1 B");
  });

  it("fails a missing artifact with the path and build command", () => {
    const v = evaluateSize(null, 65536, "/x/sla_calculator.wasm");
    expect(v.ok).toBe(false);
    expect(v.message).toContain("/x/sla_calculator.wasm");
    expect(v.message).toContain(BUILD_COMMAND);
  });
});
