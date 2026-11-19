/**
 * #1051: verify that the release manifest and the built WASM name the same artifact digest.
 *
 * The manifest is the `manifest.sha256` written by `.github/workflows/release-hash.yml`, one line
 * per artifact in `sha256sum` format:
 *
 *   <64 hex characters>  sla_calculator.wasm
 */

import * as crypto from "crypto";

export const DEFAULT_ARTIFACT_NAME = "sla_calculator.wasm";

export interface HashVerification {
  ok: boolean;
  artifact: string;
  /** Digest the manifest declares (lower case), or "" when it has no entry. */
  expected: string;
  /** Digest computed from the WASM bytes (lower case). */
  actual: string;
  message: string;
}

export class ReleaseHashMismatchError extends Error {
  constructor(public readonly result: HashVerification) {
    super(result.message);
    this.name = "ReleaseHashMismatchError";
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Parses `sha256sum`-style manifest text into artifact name -> lower-case digest. Bad lines are rejected. */
export function parseManifest(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === "") return;
    const m = /^([0-9a-fA-F]{64})[ \t]+\*?(\S+)$/.exec(line);
    if (!m) throw new Error(`[#1051] Manifest line ${i + 1} is not "<sha256>  <file>"`);
    entries.set(m[2]!, m[1]!.toLowerCase());
  });
  return entries;
}

/** Compares the manifest's digest for `artifact` with the digest of the actual WASM bytes. */
export function verifyWasmAgainstManifest(
  manifestText: string,
  wasmBytes: Uint8Array,
  artifact: string = DEFAULT_ARTIFACT_NAME
): HashVerification {
  const actual = sha256Hex(wasmBytes);
  const expected = parseManifest(manifestText).get(artifact);
  if (expected === undefined) {
    return { ok: false, artifact, expected: "", actual, message: `Release manifest has no entry for ${artifact}` };
  }
  if (expected !== actual) {
    return {
      ok: false,
      artifact,
      expected,
      actual,
      message: `Release manifest digest for ${artifact} does not match the built WASM: manifest ${expected}, built ${actual}`,
    };
  }
  return { ok: true, artifact, expected, actual, message: `Manifest digest matches built ${artifact} (${actual})` };
}

/** Throws {@link ReleaseHashMismatchError} unless the manifest and the WASM agree. */
export function assertWasmMatchesManifest(
  manifestText: string,
  wasmBytes: Uint8Array,
  artifact: string = DEFAULT_ARTIFACT_NAME
): HashVerification {
  const result = verifyWasmAgainstManifest(manifestText, wasmBytes, artifact);
  if (!result.ok) throw new ReleaseHashMismatchError(result);
  return result;
}
