import { describe, it, expect } from "vitest";
import { canonicalJson, digestChange, verifyDigest, wrapWithDigest, type ConfigChange } from "../offchain/configChangeDigest";

const change = (oldValue: unknown, newValue: unknown): ConfigChange => ({
  key: "sla.critical",
  oldValue,
  newValue,
  changedAt: 1_700_000_000,
  changedBy: "GADMIN",
});

describe("#1053 config change digest canonicalization", () => {
  it("equivalent nested objects that differ only in key order digest identically", () => {
    const a = change({ threshold: 15, tiers: { top: 200, excel: 150 } }, { penalty: 100, nested: { b: 1, a: 2 } });
    const b = change({ tiers: { excel: 150, top: 200 }, threshold: 15 }, { nested: { a: 2, b: 1 }, penalty: 100 });

    expect(digestChange(a)).toBe(digestChange(b));
  });

  it("canonicalizes objects inside arrays", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe(canonicalJson([{ a: 2, b: 1 }, { c: 4, d: 3 }]));
  });

  it("array order is semantic: reordering an array changes the digest", () => {
    const a = change(null, { ladder: ["critical", "high", "medium"] });
    const b = change(null, { ladder: ["high", "critical", "medium"] });

    expect(digestChange(a)).not.toBe(digestChange(b));
  });

  it("a different value still changes the digest", () => {
    expect(digestChange(change(null, { a: 1 }))).not.toBe(digestChange(change(null, { a: 2 })));
  });

  it("distinguishes null from an absent key, and drops undefined like JSON does", () => {
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(canonicalJson({ b: 1 }));
  });

  it("keeps the old/new/key/time/actor positions distinct", () => {
    const a = change({ x: 1 }, { y: 2 });
    const b = change({ y: 2 }, { x: 1 });

    expect(digestChange(a)).not.toBe(digestChange(b));
  });

  it("handles values with toJSON, such as dates", () => {
    const d = new Date("2026-01-01T00:00:00.000Z");

    expect(canonicalJson({ at: d })).toBe('{"at":"2026-01-01T00:00:00.000Z"}');
  });

  it("round-trips through wrapWithDigest and verifyDigest regardless of key order", () => {
    const wrapped = wrapWithDigest(change({ b: 1, a: 2 }, { d: 3, c: 4 }));
    const reordered = { ...wrapped, change: change({ a: 2, b: 1 }, { c: 4, d: 3 }) };

    expect(verifyDigest(wrapped)).toBe(true);
    expect(verifyDigest(reordered)).toBe(true);
  });

  it("sorts keys deterministically at depth", () => {
    expect(canonicalJson({ z: { y: { x: 1, w: 2 } }, a: 0 })).toBe('{"a":0,"z":{"y":{"w":2,"x":1}}}');
  });
});
