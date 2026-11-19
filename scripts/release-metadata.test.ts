import { describe, it, expect } from "vitest";
import {
  buildReleaseMetadata,
  serializeReleaseMetadata,
  readSorobanSdkVersion,
  MetadataInputs,
} from "./release-metadata";

const base: MetadataInputs = {
  commit: "a".repeat(40),
  tag: "v1.0.0",
  rustVersion: "rustc 1.80.0",
  cargoVersion: "cargo 1.80.0",
  sorobanSdk: "21.0.0",
  buildTarget: "wasm32-unknown-unknown",
  buildProfile: "release",
  wasmSha256: "b".repeat(64),
  wasmSizeBytes: 1234,
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("release metadata", () => {
  it("contains commit, toolchain, SDK, target and artifact hash", () => {
    const m = buildReleaseMetadata(base) as any;
    expect(m.source.commit).toBe(base.commit);
    expect(m.toolchain.rust).toBe("rustc 1.80.0");
    expect(m.sdk.soroban_sdk).toBe("21.0.0");
    expect(m.build.target).toBe("wasm32-unknown-unknown");
    expect(m.artifact.sha256).toBe(base.wasmSha256);
  });

  it("is stable across runs apart from the volatile block", () => {
    const a = serializeReleaseMetadata(buildReleaseMetadata(base));
    const b = serializeReleaseMetadata(
      buildReleaseMetadata({ ...base, timestamp: "2027-02-02T00:00:00.000Z" }),
    );
    const strip = (s: string) => JSON.stringify({ ...JSON.parse(s), volatile: undefined });
    expect(strip(a)).toBe(strip(b));
    expect(a).not.toBe(b);
    expect(serializeReleaseMetadata(buildReleaseMetadata(base))).toBe(a);
  });

  it("reads the soroban-sdk version from Cargo.lock text", () => {
    expect(
      readSorobanSdkVersion('[[package]]\nname = "soroban-sdk"\nversion = "21.7.7"\n'),
    ).toBe("21.7.7");
    expect(readSorobanSdkVersion("")).toBe("unknown");
  });
});
