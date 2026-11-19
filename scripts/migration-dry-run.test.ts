import { describe, it, expect } from "vitest";
import { planVersionPath } from "./migration-dry-run";

const upgrades = { 1: [2], 2: [3] };

describe("planVersionPath", () => {
  it("accepts a reachable multi-step path and lists it", () => {
    const p = planVersionPath(1, 3, upgrades, 3);
    expect(p.ok).toBe(true);
    expect(p.path).toEqual([1, 2, 3]);
    expect(p.source).toBe(1);
    expect(p.target).toBe(3);
  });

  it("accepts source equal to target", () => {
    expect(planVersionPath(2, 2, upgrades, 3).ok).toBe(true);
  });

  it("rejects an unsupported jump", () => {
    const p = planVersionPath(1, 3, { 1: [2] }, 3);
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/No supported upgrade path from v1 to v3/);
  });

  it("rejects downgrades and targets newer than the build", () => {
    expect(planVersionPath(3, 1, upgrades, 3).error).toMatch(/Downgrade/);
    expect(planVersionPath(1, 4, upgrades, 3).error).toMatch(/newer than this build/);
  });

  it("rejects invalid versions", () => {
    expect(planVersionPath(0, 1).ok).toBe(false);
  });
});
