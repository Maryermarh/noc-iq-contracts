import { describe, it, expect } from "vitest";
import {
  buildDisbursementRequest,
  resolveTrustline,
  UnsupportedAssetNetworkError,
  type AssetNetworkRegistry,
} from "../offchain/payoutDisbursementInterface";

const ISSUER_TEST = "GTESTISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ISSUER_MAIN = "GMAINISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const registry: AssetNetworkRegistry = {
  testnet: [{ code: "XLM" }, { code: "USDC", issuer: ISSUER_TEST }],
  mainnet: [{ code: "XLM" }, { code: "USDC", issuer: ISSUER_MAIN }],
};

const base = { outage_id: "OUT001", recipient: "GRECIPIENT", amount: 500, penalty_bps: 0 };

describe("#1062 payout disbursement asset/network pairs", () => {
  it("the native asset needs no trustline on any network", () => {
    for (const network of ["mainnet", "testnet", "futurenet"] as const) {
      expect(resolveTrustline(network, { code: "XLM" })).toEqual({
        required: false,
        asset_code: "XLM",
        network,
      });
    }
  });

  it("a configured asset maps to its issuer's trustline on that network", () => {
    expect(resolveTrustline("testnet", { code: "USDC", issuer: ISSUER_TEST }, registry)).toEqual({
      required: true,
      asset_code: "USDC",
      asset_issuer: ISSUER_TEST,
      network: "testnet",
    });
    expect(resolveTrustline("mainnet", { code: "USDC", issuer: ISSUER_MAIN }, registry)).toMatchObject({
      asset_issuer: ISSUER_MAIN,
      network: "mainnet",
    });
  });

  it("rejects an asset that is not configured for the network", () => {
    expect(() => resolveTrustline("futurenet", { code: "USDC", issuer: ISSUER_TEST }, registry)).toThrow(
      UnsupportedAssetNetworkError,
    );
  });

  it("rejects an asset code issued by a different issuer than the one configured for that network", () => {
    expect(() => resolveTrustline("mainnet", { code: "USDC", issuer: ISSUER_TEST }, registry)).toThrow(
      UnsupportedAssetNetworkError,
    );
  });

  it("rejects a non-native asset by default, since none are configured", () => {
    expect(() => resolveTrustline("testnet", { code: "USDC", issuer: ISSUER_TEST })).toThrow(
      UnsupportedAssetNetworkError,
    );
  });

  it("does not treat an issuer-less non-XLM code as the native asset", () => {
    expect(() => resolveTrustline("testnet", { code: "USDC" }, registry)).toThrow(UnsupportedAssetNetworkError);
  });

  it("builds a request for a supported pair and attaches the trustline metadata", () => {
    const req = buildDisbursementRequest({ ...base, network: "testnet", asset: { code: "XLM" } });

    expect(req).toMatchObject({ outage_id: "OUT001", amount: 500, network: "testnet" });
    expect(req.trustline).toEqual({ required: false, asset_code: "XLM", network: "testnet" });
  });

  it("fails before building a request for an unsupported pair", () => {
    expect(() =>
      buildDisbursementRequest({ ...base, network: "mainnet", asset: { code: "EURC", issuer: ISSUER_MAIN } }, registry),
    ).toThrow(/not supported on network mainnet/);
  });

  it("names the asset and network in the error and does not leak the recipient", () => {
    try {
      buildDisbursementRequest({ ...base, network: "mainnet", asset: { code: "EURC" } }, registry);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedAssetNetworkError);
      expect((e as Error).message).toContain("EURC");
      expect((e as Error).message).toContain("mainnet");
      expect((e as Error).message).not.toContain("GRECIPIENT");
    }
  });
});
