/**
 * Release evidence metadata (#1082).
 *
 * Pure builder for the metadata.json in a release evidence bundle. Records
 * everything needed to reproduce the WASM artifact (commit, toolchain,
 * SDK, target, artifact hash). Output is canonical: keys are sorted and
 * the only time-dependent value lives under `volatile`, so two runs on the
 * same inputs produce identical JSON apart from that block.
 */

export interface MetadataInputs {
  commit: string;
  tag: string;
  rustVersion: string;
  cargoVersion: string;
  sorobanSdk: string;
  buildTarget: string;
  buildProfile: string;
  wasmSha256: string;
  wasmSizeBytes: number;
  /** Explicitly volatile; excluded from the stable portion. */
  timestamp: string;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function buildReleaseMetadata(i: MetadataInputs): Record<string, unknown> {
  return sortKeys({
    schema_version: 1,
    source: { commit: i.commit, tag: i.tag },
    toolchain: { rust: i.rustVersion, cargo: i.cargoVersion },
    sdk: { soroban_sdk: i.sorobanSdk },
    build: { target: i.buildTarget, profile: i.buildProfile },
    artifact: { sha256: i.wasmSha256, size_bytes: i.wasmSizeBytes },
    volatile: { generated_at: i.timestamp },
  }) as Record<string, unknown>;
}

export function serializeReleaseMetadata(meta: Record<string, unknown>): string {
  return JSON.stringify(meta, null, 2) + "\n";
}

/** Extracts the pinned soroban-sdk version from Cargo.lock text. */
export function readSorobanSdkVersion(cargoLock: string): string {
  const m = /name = "soroban-sdk"\s*\nversion = "([^"]+)"/.exec(cargoLock);
  return m ? m[1] : "unknown";
}
