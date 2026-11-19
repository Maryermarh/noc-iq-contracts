import { describe, it, expect } from "vitest";
import { NetworkMismatchError, assertManifestNetwork } from "../offchain/contractMetadata";

describe("#1054 release manifest network check", () => {
  it("accepts a manifest for the target network", () => {
    expect(() => assertManifestNetwork({ network: "testnet" }, "testnet")).not.toThrow();
    expect(() => assertManifestNetwork({ network: "mainnet" }, "mainnet")).not.toThrow();
  });

  it("rejects a manifest for another network and reports expected and actual ids", () => {
    try {
      assertManifestNetwork({ network: "mainnet" }, "testnet");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(NetworkMismatchError);
      const err = e as NetworkMismatchError;
      expect(err.expected).toBe("testnet");
      expect(err.actual).toBe("mainnet");
      expect(err.message).toContain('"mainnet"');
      expect(err.message).toContain('"testnet"');
    }
  });

  it("rejects a manifest with no network", () => {
    for (const manifest of [{}, { network: undefined }, { network: null }, { network: "" }]) {
      expect(() => assertManifestNetwork(manifest, "testnet")).toThrow(/<missing>/);
    }
  });

  it("rejects an unrecognized network without echoing it", () => {
    const junk = "https://rpc.example/?token=SECRET_TOKEN_123";

    try {
      assertManifestNetwork({ network: junk }, "testnet");
      throw new Error("expected a throw");
    } catch (e) {
      expect((e as Error).message).toContain("<unrecognized>");
      expect((e as Error).message).not.toContain("SECRET_TOKEN_123");
    }
  });

  it("rejects a non-string network", () => {
    expect(() => assertManifestNetwork({ network: 42 }, "mainnet")).toThrow(/<unrecognized>/);
  });

  it("does not report any other manifest field", () => {
    try {
      assertManifestNetwork({ network: "mainnet", admin_secret: "SABCDEF" } as never, "testnet");
    } catch (e) {
      expect((e as Error).message).not.toContain("SABCDEF");
    }
  });

  it("is case sensitive: a differently cased id is not a known network", () => {
    expect(() => assertManifestNetwork({ network: "TESTNET" }, "testnet")).toThrow(/<unrecognized>/);
  });
});
