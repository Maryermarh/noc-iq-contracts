import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  GENERIC_ERROR,
  compareCatalogToContract,
  describeRuntimeError,
  errorCatalog,
  parseContractErrors,
} from "../offchain/deterministicErrorCatalog";

const LIB_RS = fs.readFileSync(path.resolve(__dirname, "../sla_calculator/src/lib.rs"), "utf8");

describe("#1055 error catalog covers the contract's error codes", () => {
  it("parses the SLAError enum from the contract source", () => {
    const variants = parseContractErrors(LIB_RS);

    expect(variants.length).toBeGreaterThan(0);
    expect(variants[0]).toEqual({ name: "AlreadyInitialized", code: 1 });
    expect(new Set(variants.map((v) => v.code)).size).toBe(variants.length);
  });

  it("has a catalog entry for every exported contract error, and none for removed ones", () => {
    const drift = compareCatalogToContract(LIB_RS);

    expect(drift.missingFromCatalog).toEqual([]);
    expect(drift.staleInCatalog).toEqual([]);
  });

  it("reports a newly added contract error by name", () => {
    const withNewError = LIB_RS.replace(/(pub enum SLAError \{[\s\S]*?)\n\}/, "$1\n    BrandNewFailure = 99,\n}");

    const drift = compareCatalogToContract(withNewError);

    expect(drift.missingFromCatalog).toEqual([{ name: "BrandNewFailure", code: 99 }]);
  });

  it("reports a catalog entry whose contract error was removed", () => {
    const withoutLast = LIB_RS.replace(/\n\s*DivisionByZero = 24,[^\n]*/, "");

    expect(compareCatalogToContract(withoutLast).staleInCatalog).toEqual(["DIVISION_BY_ZERO"]);
  });

  it("gives every contract entry a message and a retry classification", () => {
    for (const e of errorCatalog.filter((x) => x.contractCode !== undefined)) {
      expect(e.message.length).toBeGreaterThan(0);
      expect(typeof e.retryable).toBe("boolean");
    }
  });

  it("uses unique codes", () => {
    const codes = errorCatalog.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("#1055 runtime errors", () => {
  it("maps a numeric contract code to its catalog entry", () => {
    expect(describeRuntimeError(3)).toMatchObject({ code: "UNAUTHORIZED", contractName: "Unauthorized" });
  });

  it("maps an Error(Contract, #N) string", () => {
    expect(describeRuntimeError("HostError: Error(Contract, #6)").code).toBe("CONTRACT_PAUSED");
  });

  it("gives an unknown numeric code the generic entry", () => {
    expect(describeRuntimeError(9999)).toBe(GENERIC_ERROR);
  });

  it("gives an unknown string the generic entry without leaking its content", () => {
    const secret = "GSECRETACCOUNT balance=12345 key=sk_live_abc";
    const entry = describeRuntimeError(`unexpected: ${secret}`);

    expect(entry).toBe(GENERIC_ERROR);
    expect(JSON.stringify(entry)).not.toContain("GSECRETACCOUNT");
    expect(JSON.stringify(entry)).not.toContain("sk_live");
  });

  it("treats other value types as unknown", () => {
    for (const raw of [undefined, null, {}, [], 1.5, NaN, true]) {
      expect(describeRuntimeError(raw)).toBe(GENERIC_ERROR);
    }
  });

  it("a contract error text with an unknown number is still generic", () => {
    expect(describeRuntimeError("Error(Contract, #777)")).toBe(GENERIC_ERROR);
  });
});
