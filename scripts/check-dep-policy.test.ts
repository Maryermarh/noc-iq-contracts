import { describe, it, expect } from "vitest";
import { validateExceptions, lockPackages, DepException } from "./check-dep-policy";

const known = new Set(["soroban-sdk", "serde"]);
const now = new Date("2026-06-01T12:00:00Z");
const ok: DepException = {
  advisory: "RUSTSEC-2024-0001",
  package: "serde",
  expires: "2026-12-31",
  rationale: "No fix released; not reachable from contract code",
};

describe("validateExceptions", () => {
  it("accepts a current exact exception and exposes expiry and rationale", () => {
    const v = validateExceptions([ok], known, now);
    expect(v.errors).toEqual([]);
    expect(v.valid[0].expires).toBe("2026-12-31");
    expect(v.valid[0].rationale).toContain("not reachable");
  });

  it("rejects an expired exception", () => {
    const v = validateExceptions([{ ...ok, expires: "2026-05-31" }], known, now);
    expect(v.errors[0]).toMatch(/expired on 2026-05-31/);
  });

  it("rejects wildcard advisory or package", () => {
    expect(validateExceptions([{ ...ok, advisory: "RUSTSEC-*" }], known, now).errors).toHaveLength(1);
    expect(validateExceptions([{ ...ok, package: "*" }], known, now).errors[0]).toMatch(/wildcards/);
  });

  it("rejects a package that is not a dependency", () => {
    const v = validateExceptions([{ ...ok, package: "left-pad" }], known, now);
    expect(v.errors[0]).toMatch(/not in the dependency set/);
  });

  it("is valid through the end of the expiry day", () => {
    const v = validateExceptions([{ ...ok, expires: "2026-06-01" }], known, now);
    expect(v.errors).toEqual([]);
  });
});

describe("lockPackages", () => {
  it("collects package names from Cargo.lock text", () => {
    expect(lockPackages('[[package]]\nname = "serde"\nversion = "1"\n').has("serde")).toBe(true);
  });
});
