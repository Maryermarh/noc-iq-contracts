/**
 * SC-W5-076: Interface contract for future payout/disbursement companion contracts.
 * Defines the shared interface that payout and disbursement contracts must satisfy.
 */

export interface PayoutRequest {
  outage_id: string;
  recipient:  string;
  amount:     number;
  penalty_bps: number;
}

export interface DisbursementResult {
  outage_id: string;
  disbursed: boolean;
  amount:    number;
  reason?:   string;
}

export interface PayoutDisbursementContract {
  requestPayout(req: PayoutRequest): DisbursementResult;
  getPendingPayouts(): PayoutRequest[];
  getTotalDisbursed(): number;
}

// Minimal in-process stub that satisfies the interface for integration testing
export class StubPayoutContract implements PayoutDisbursementContract {
  private disbursed = 0;
  private pending: PayoutRequest[] = [];

  requestPayout(req: PayoutRequest): DisbursementResult {
    if (req.amount <= 0) return { outage_id: req.outage_id, disbursed: false, amount: 0, reason: "invalid amount" };
    this.disbursed += req.amount;
    return { outage_id: req.outage_id, disbursed: true, amount: req.amount };
  }

  getPendingPayouts(): PayoutRequest[] { return this.pending; }
  getTotalDisbursed(): number { return this.disbursed; }
}

// ---------------------------------------------------------------------------
// #1062: asset / network validation before a disbursement request exists
// ---------------------------------------------------------------------------

export type StellarNetwork = "mainnet" | "testnet" | "futurenet";

/** An asset as the payout flow names it. The native asset has code "XLM" and no issuer. */
export interface AssetRef {
  code: string;
  issuer?: string;
}

/** What a recipient account needs before it can receive the asset. */
export interface TrustlineMetadata {
  /** False for the native asset, which needs no trustline. */
  required: boolean;
  asset_code: string;
  asset_issuer?: string;
  network: StellarNetwork;
}

export type AssetNetworkRegistry = Partial<Record<StellarNetwork, AssetRef[]>>;

/**
 * The native asset is supported everywhere. Other assets must be configured explicitly per
 * network (their issuers differ between networks), so none are assumed by default.
 */
export const DEFAULT_ASSET_NETWORK_REGISTRY: AssetNetworkRegistry = {
  mainnet: [{ code: "XLM" }],
  testnet: [{ code: "XLM" }],
  futurenet: [{ code: "XLM" }],
};

export class UnsupportedAssetNetworkError extends Error {
  constructor(public readonly network: string, public readonly asset: AssetRef) {
    super(
      `[SC-W5-076] Asset ${asset.code}${asset.issuer ? `:${asset.issuer}` : ""} is not supported on network ${network}`
    );
    this.name = "UnsupportedAssetNetworkError";
  }
}

function isNative(asset: AssetRef): boolean {
  return asset.code === "XLM" && asset.issuer === undefined;
}

/**
 * Resolves the trustline metadata for an asset on a network, or throws
 * {@link UnsupportedAssetNetworkError} when that pair is not in the registry.
 */
export function resolveTrustline(
  network: StellarNetwork,
  asset: AssetRef,
  registry: AssetNetworkRegistry = DEFAULT_ASSET_NETWORK_REGISTRY
): TrustlineMetadata {
  const supported = registry[network] ?? [];
  const match = supported.find((a) => a.code === asset.code && a.issuer === asset.issuer);
  if (!match) throw new UnsupportedAssetNetworkError(network, asset);
  return isNative(match)
    ? { required: false, asset_code: "XLM", network }
    : { required: true, asset_code: match.code, asset_issuer: match.issuer, network };
}

export interface DisbursementRequest extends PayoutRequest {
  network: StellarNetwork;
  asset: AssetRef;
  trustline: TrustlineMetadata;
}

/**
 * Builds a disbursement request. The asset/network pair is checked first, so an unsupported pair
 * fails here, before anything downstream can build a transaction from it.
 */
export function buildDisbursementRequest(
  params: PayoutRequest & { network: StellarNetwork; asset: AssetRef },
  registry: AssetNetworkRegistry = DEFAULT_ASSET_NETWORK_REGISTRY
): DisbursementRequest {
  const trustline = resolveTrustline(params.network, params.asset, registry);
  return { ...params, trustline };
}
