/**
 * SC-019: Contract metadata and capabilities introspection helper.
 * Provides a deterministic off-chain view of contract version, supported
 * capabilities, and health status for backend startup/health-check use.
 */

interface ContractMetadata {
  version: string;
  capabilities: string[];
  paused: boolean;
  operator: string;
  admin: string;
  statsEnabled: boolean;
  historyEnabled: boolean;
}

// Simulates the response shape from get_metadata() on the contract
function parseMetadata(raw: Record<string, unknown>): ContractMetadata {
  return {
    version: String(raw.version ?? "unknown"),
    capabilities: Array.isArray(raw.capabilities) ? raw.capabilities as string[] : [],
    paused: Boolean(raw.paused),
    operator: String(raw.operator ?? ""),
    admin: String(raw.admin ?? ""),
    statsEnabled: Boolean(raw.stats_enabled),
    historyEnabled: Boolean(raw.history_enabled),
  };
}

function validateMetadata(meta: ContractMetadata): void {
  if (!meta.version || meta.version === "unknown") {
    throw new Error("[SC-019] Metadata missing version field");
  }
  if (meta.capabilities.length === 0) {
    throw new Error("[SC-019] Metadata reports no capabilities");
  }
  if (!meta.admin) {
    throw new Error("[SC-019] Metadata missing admin address");
  }
  console.log(`  ✓ version: ${meta.version}`);
  console.log(`  ✓ capabilities: ${meta.capabilities.join(", ")}`);
  console.log(`  ✓ paused: ${meta.paused}`);
  console.log(`  ✓ statsEnabled: ${meta.statsEnabled}, historyEnabled: ${meta.historyEnabled}`);
}

const rawResponse: Record<string, unknown> = {
  version: "1.0.0",
  capabilities: ["calculate_sla", "get_stats", "get_history", "governance"],
  paused: false,
  operator: "GOPER123",
  admin: "GADMIN456",
  stats_enabled: true,
  history_enabled: true,
};

console.log("[SC-019] Contract metadata introspection:");
const metadata = parseMetadata(rawResponse);
validateMetadata(metadata);
console.log("Metadata introspection passed.");

// ---------------------------------------------------------------------------
// #1054: release manifest network check
// ---------------------------------------------------------------------------

export type ReleaseNetwork = "mainnet" | "testnet" | "futurenet";

const RELEASE_NETWORKS: readonly string[] = ["mainnet", "testnet", "futurenet"];

/** The fields of a release manifest this check reads. */
export interface ReleaseManifest {
  network?: unknown;
}

export class NetworkMismatchError extends Error {
  constructor(
    public readonly expected: ReleaseNetwork,
    /** The manifest's network id, or a placeholder when it was missing or not a known id. */
    public readonly actual: string
  ) {
    super(`[SC-019] Release manifest targets network "${actual}" but this release targets "${expected}"`);
    this.name = "NetworkMismatchError";
  }
}

/**
 * Rejects a release manifest that names a different network than the release target. Run it
 * before any deployment or invocation: a matching artifact hash is not enough. Only network
 * identifiers appear in the error; any other manifest content, and anything that is not a known
 * network id, is replaced by a placeholder so secrets cannot leak through a diagnostic.
 */
export function assertManifestNetwork(manifest: ReleaseManifest, expected: ReleaseNetwork): void {
  const raw = manifest.network;
  if (raw === undefined || raw === null || raw === "") throw new NetworkMismatchError(expected, "<missing>");
  if (typeof raw !== "string" || !RELEASE_NETWORKS.includes(raw)) throw new NetworkMismatchError(expected, "<unrecognized>");
  if (raw !== expected) throw new NetworkMismatchError(expected, raw);
}
