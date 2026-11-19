import { describe, it, expect } from "vitest";
import {
  ReleaseHashMismatchError,
  assertWasmMatchesManifest,
  parseManifest,
  sha256Hex,
  verifyWasmAgainstManifest,
} from "../offchain/releaseManifest";

const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]); // "\0asm" + version
const DIGEST = sha256Hex(WASM);
const manifest = (digest: string, name = "sla_calculator.wasm") => `${digest}  ${name}\n`;

describe("#1051 release manifest vs WASM digest", () => {
  it("computes a 64 character lower-case SHA-256", () => {
    expect(DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("accepts a manifest whose digest matches the WASM", () => {
    const r = verifyWasmAgainstManifest(manifest(DIGEST), WASM);

    expect(r).toMatchObject({ ok: true, expected: DIGEST, actual: DIGEST });
  });

  it("matches regardless of the case of the digest in the manifest", () => {
    expect(verifyWasmAgainstManifest(manifest(DIGEST.toUpperCase()), WASM).ok).toBe(true);
  });

  it("rejects a mismatch and reports both digests", () => {
    const other = sha256Hex(new Uint8Array([1, 2, 3]));

    const r = verifyWasmAgainstManifest(manifest(other), WASM);

    expect(r.ok).toBe(false);
    expect(r.expected).toBe(other);
    expect(r.actual).toBe(DIGEST);
    expect(r.message).toContain(other);
    expect(r.message).toContain(DIGEST);
  });

  it("blocks with a typed error when asserting a mismatch", () => {
    expect(() => assertWasmMatchesManifest(manifest("0".repeat(64)), WASM)).toThrow(ReleaseHashMismatchError);
  });

  it("returns the verification when asserting a match", () => {
    expect(assertWasmMatchesManifest(manifest(DIGEST), WASM).ok).toBe(true);
  });

  it("reports a manifest with no entry for the artifact", () => {
    const r = verifyWasmAgainstManifest(manifest(DIGEST, "other.wasm"), WASM);

    expect(r.ok).toBe(false);
    expect(r.message).toContain("no entry for sla_calculator.wasm");
  });

  it("an empty manifest fails rather than passing vacuously", () => {
    expect(verifyWasmAgainstManifest("", WASM).ok).toBe(false);
    expect(verifyWasmAgainstManifest("\n\n", WASM).ok).toBe(false);
  });

  it("a manifest for different bytes of the same length fails", () => {
    const tampered = new Uint8Array(WASM);
    tampered[7] = 9;

    expect(verifyWasmAgainstManifest(manifest(DIGEST), tampered).ok).toBe(false);
  });

  it("rejects malformed manifest lines instead of guessing", () => {
    for (const bad of ["not a digest  sla_calculator.wasm", `${DIGEST.slice(0, 63)}  sla_calculator.wasm`, DIGEST]) {
      expect(() => parseManifest(bad)).toThrow(/not "<sha256>  <file>"/);
    }
  });

  it("parses several entries and binary-mode markers", () => {
    const entries = parseManifest(`${DIGEST}  a.wasm\n${DIGEST.toUpperCase()} *b.wasm\r\n`);

    expect([...entries.keys()]).toEqual(["a.wasm", "b.wasm"]);
    expect(entries.get("b.wasm")).toBe(DIGEST);
  });
});
