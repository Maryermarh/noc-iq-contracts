import { describe, it, expect } from "vitest";
import { checkNetworkIdentity, NETWORK_PASSPHRASES } from "./pre-deploy-verify";

describe("checkNetworkIdentity", () => {
  it("passes when configured and artifact networks agree", () => {
    const r = checkNetworkIdentity({ network: "testnet" }, { target_network: "TESTNET" });
    expect(r.passed).toBe(true);
  });

  it("fails with an actionable message on mismatch", () => {
    const r = checkNetworkIdentity({ network: "MAINNET" }, { target_network: "TESTNET" });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain("MAINNET");
    expect(r.detail).toContain("TESTNET");
    expect(r.detail).toMatch(/Rebuild/);
  });

  it("fails when the passphrase belongs to another network", () => {
    const r = checkNetworkIdentity(
      { network: "MAINNET", passphrase: NETWORK_PASSPHRASES.TESTNET },
      { target_network: "MAINNET" },
    );
    expect(r.passed).toBe(false);
  });

  it("fails when metadata or network is missing, never mentioning keys", () => {
    expect(checkNetworkIdentity({ network: "TESTNET" }, null).passed).toBe(false);
    const r = checkNetworkIdentity({}, { target_network: "TESTNET" });
    expect(r.passed).toBe(false);
    expect(r.detail.toLowerCase()).not.toContain("secret");
  });
});
