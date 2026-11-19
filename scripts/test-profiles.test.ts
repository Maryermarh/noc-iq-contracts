import { describe, it, expect } from "vitest";
import { selectProfiles, UnknownProfileError, formatSummary, summaryJson } from "./test-profiles";
import { resolveProfile } from "./run-tests";

const known = ["fast", "full", "security"];

describe("selectProfiles", () => {
  it("runs requested profiles and reports the rest as skipped with a reason", () => {
    const plan = selectProfiles(["fast"], known);
    expect(plan.run).toEqual(["fast"]);
    expect(plan.skipped).toEqual([
      { profile: "full", status: "skipped", reason: "not requested" },
      { profile: "security", status: "skipped", reason: "not requested" },
    ]);
  });

  it("records an explicit skip reason", () => {
    const plan = selectProfiles(["fast", "security"], known, { security: "no signing key in CI" });
    expect(plan.run).toEqual(["fast"]);
    expect(plan.skipped.find((s) => s.profile === "security")?.reason).toBe("no signing key in CI");
  });

  it("throws for an unknown requested or skipped profile", () => {
    expect(() => selectProfiles(["bogus"], known)).toThrow(UnknownProfileError);
    expect(() => selectProfiles(["fast"], known, { bogus: "x" })).toThrow(UnknownProfileError);
  });
});

describe("summaries", () => {
  const outcomes = [
    { profile: "fast", status: "passed" as const },
    { profile: "full", status: "skipped" as const, reason: "not requested" },
  ];

  it("human summary lists skipped profiles and reasons", () => {
    expect(formatSummary(outcomes)).toContain("[SKIP] full — not requested");
  });

  it("machine summary is JSON with the same data", () => {
    expect(JSON.parse(summaryJson(outcomes)).profiles).toEqual(outcomes);
  });
});

describe("run-tests resolveProfile", () => {
  it("resolves known presets and rejects unknown ones", () => {
    expect(resolveProfile("calc")).toBe("calculate_sla");
    expect(() => resolveProfile("nope")).toThrow(/Unknown profile/);
  });
});
