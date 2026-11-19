import { describe, it, expect } from "vitest";
import {
  SLACalculatorClient,
  TimeoutError,
  decodeContractEvent,
  TransactionStatusResult,
} from "../src/client";
import { toScVal, fromScVal } from "../src/scval";
import { CANONICAL_SEVERITIES } from "../src/types";

describe("SLACalculatorClient", () => {
  const client = new SLACalculatorClient({
    contractId: "CABC1234567890ABCDEF",
    networkPassphrase: "Testnet ; SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
  });

  it("exposes contract address and network", () => {
    expect(client.contractAddress).toBe("CABC1234567890ABCDEF");
    expect(client.network).toContain("Testnet");
  });

  describe("configuration methods", () => {
    it("getConfig returns ok", async () => {
      const result = await client.getConfig("critical");
      expect(result.ok).toBe(true);
    });

    it("listConfigs returns ok", async () => {
      const result = await client.listConfigs();
      expect(result.ok).toBe(true);
    });

    it("getConfigSnapshot returns ok", async () => {
      const result = await client.getConfigSnapshot();
      expect(result.ok).toBe(true);
    });

    it("getConfigVersionHash returns ok", async () => {
      const result = await client.getConfigVersionHash();
      expect(result.ok).toBe(true);
    });

    it("getConfigCount returns ok", async () => {
      const result = await client.getConfigCount();
      expect(result.ok).toBe(true);
    });
  });

  describe("SLA calculation methods", () => {
    it("calculateSla returns ok", async () => {
      const result = await client.calculateSla(
        "operator1",
        "outage-001",
        "high",
        90,
      );
      expect(result.ok).toBe(true);
    });

    it("calculateSlaView returns ok", async () => {
      const result = await client.calculateSlaView(
        "outage-002",
        "critical",
        60,
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("history methods", () => {
    it("getHistory returns ok", async () => {
      const result = await client.getHistory();
      expect(result.ok).toBe(true);
    });

    it("getHistoryPage returns ok", async () => {
      const result = await client.getHistoryPage(0, 10);
      expect(result.ok).toBe(true);
    });

    it("getHistoryByOutage returns ok", async () => {
      const result = await client.getHistoryByOutage("outage-001");
      expect(result.ok).toBe(true);
    });

    it("getLatestByOutage returns ok", async () => {
      const result = await client.getLatestByOutage("outage-001");
      expect(result.ok).toBe(true);
    });
  });

  describe("pause methods", () => {
    it("isPaused returns ok", async () => {
      const result = await client.isPaused();
      expect(result.ok).toBe(true);
    });

    it("getPauseInfo returns ok", async () => {
      const result = await client.getPauseInfo();
      expect(result.ok).toBe(true);
    });
  });

  describe("role methods", () => {
    it("getAdmin returns ok", async () => {
      const result = await client.getAdmin();
      expect(result.ok).toBe(true);
    });

    it("getOperator returns ok", async () => {
      const result = await client.getOperator();
      expect(result.ok).toBe(true);
    });
  });

  describe("version methods", () => {
    it("getVersionInfo returns ok", async () => {
      const result = await client.getVersionInfo();
      expect(result.ok).toBe(true);
    });

    it("getMigrationState returns ok", async () => {
      const result = await client.getMigrationState();
      expect(result.ok).toBe(true);
    });

    it("getStorageVersion returns ok", async () => {
      const result = await client.getStorageVersion();
      expect(result.ok).toBe(true);
    });
  });

  describe("types", () => {
    it("CANONICAL_SEVERITIES contains expected entries", () => {
      expect(CANONICAL_SEVERITIES).toEqual([
        "critical",
        "high",
        "medium",
        "low",
      ]);
    });
  });

  describe("pre-flight simulation", () => {
    it("preflightInvoke returns success and a recommended fee", async () => {
      const result = await client.preflightInvoke("calculate_sla", [
        "outage-001",
        "high",
        90,
      ]);
      expect(result.success).toBe(true);
      expect(result.recommendedFee).toBeGreaterThan(0n);
    });
  });

  describe("contract event decoding", () => {
    it("decodeContractEvent unwraps ScVal event data into a typed object", () => {
      const event = decodeContractEvent<{ outage_id: string; amount: bigint }>({
        type: "sla_calculated",
        ledger: 123,
        data: toScVal({ outage_id: "outage-001", amount: 500n }),
      });
      expect(event.type).toBe("sla_calculated");
      expect(event.ledger).toBe(123);
      expect(event.data).toEqual({ outage_id: "outage-001", amount: 500n });
    });
  });

  describe("transaction confirmation polling", () => {
    class PendingThenSuccessClient extends SLACalculatorClient {
      callCount = 0;
      callTimestamps: number[] = [];

      protected async getTransactionStatus(
        txHash: string,
      ): Promise<TransactionStatusResult> {
        this.callTimestamps.push(Date.now());
        this.callCount += 1;
        if (this.callCount < 2) {
          return { status: "PENDING", txHash };
        }
        return { status: "SUCCESS", txHash };
      }
    }

    it("resolves once the transaction reaches a terminal status", async () => {
      const testClient = new PendingThenSuccessClient({
        contractId: "CABC1234567890ABCDEF",
        networkPassphrase: "Testnet ; SDF Network ; September 2015",
        rpcUrl: "https://soroban-testnet.stellar.org",
      });

      const result =
        await testClient.waitForTransactionConfirmation("txhash-1");

      expect(result).toEqual({ status: "SUCCESS", txHash: "txhash-1" });
      expect(testClient.callCount).toBe(2);
      // First retry should wait ~1s (the initial backoff interval).
      const gap =
        testClient.callTimestamps[1] - testClient.callTimestamps[0];
      expect(gap).toBeGreaterThanOrEqual(900);
    });

    it("throws TimeoutError if no terminal status is reached in time", async () => {
      class AlwaysPendingClient extends SLACalculatorClient {
        protected async getTransactionStatus(
          txHash: string,
        ): Promise<TransactionStatusResult> {
          return { status: "PENDING", txHash };
        }
      }

      const testClient = new AlwaysPendingClient({
        contractId: "CABC1234567890ABCDEF",
        networkPassphrase: "Testnet ; SDF Network ; September 2015",
        rpcUrl: "https://soroban-testnet.stellar.org",
      });

      await expect(
        testClient.waitForTransactionConfirmation("txhash-2", 500),
      ).rejects.toBeInstanceOf(TimeoutError);
    });
  });
});

describe("scval conversions", () => {
  it("round-trips primitives through toScVal/fromScVal", () => {
    expect(fromScVal(toScVal(42))).toBe(42);
    expect(fromScVal(toScVal(true))).toBe(true);
    expect(fromScVal(toScVal("hello"))).toBe("hello");
    expect(fromScVal(toScVal(500n))).toBe(500n);
    expect(fromScVal(toScVal(null))).toBeNull();
  });

  it("tags Stellar addresses distinctly from plain strings", () => {
    const address = "G" + "A".repeat(55);
    expect(toScVal(address).type).toBe("address");
    expect(toScVal("not-an-address").type).toBe("string");
  });

  it("round-trips arrays and objects", () => {
    expect(fromScVal(toScVal([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(fromScVal(toScVal({ a: 1, b: "two" }))).toEqual({
      a: 1,
      b: "two",
    });
  });
});

import { ScValRangeError } from "../src/scval";

describe("ScVal integer range checks (issue #1074)", () => {
  const U32_MAX = 4_294_967_295;
  const I32_MIN = -2_147_483_648;
  const U128_MAX = (1n << 128n) - 1n;
  const I128_MIN = -(1n << 127n);

  it("accepts the minimum and maximum of each supported type", () => {
    expect(toScVal(0)).toEqual({ type: "u32", value: 0 });
    expect(toScVal(U32_MAX)).toEqual({ type: "u32", value: U32_MAX });
    expect(toScVal(I32_MIN)).toEqual({ type: "i32", value: I32_MIN });
    expect(toScVal(U128_MAX)).toEqual({ type: "u128", value: U128_MAX });
    expect(toScVal(I128_MIN)).toEqual({ type: "i128", value: I128_MIN });
  });

  it("rejects values one outside each boundary", () => {
    expect(() => toScVal(U32_MAX + 1)).toThrow(ScValRangeError);
    expect(() => toScVal(I32_MIN - 1)).toThrow(ScValRangeError);
    expect(() => toScVal(U128_MAX + 1n)).toThrow(ScValRangeError);
    expect(() => toScVal(I128_MIN - 1n)).toThrow(ScValRangeError);
  });

  it("rejects non-safe and non-finite numbers rather than truncating them", () => {
    expect(() => toScVal(Number.MAX_SAFE_INTEGER * 2)).toThrow(ScValRangeError);
    expect(() => toScVal(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => toScVal(Number.NaN)).toThrow();
  });

  it("names the field in the error, including nested array and object fields", () => {
    expect(() => toScVal(U32_MAX + 1, "mttr_minutes")).toThrow(/mttr_minutes/);
    expect(() => toScVal({ amount: U128_MAX + 1n }, "config")).toThrow(/config\.amount/);
    expect(() => toScVal([1, 2, 99_999_999_999], "ids")).toThrow(/ids\[2\]/);
  });

  it("names the argument position when used as args.map(toScVal)", () => {
    expect(() => [1, 2, U32_MAX + 1].map(toScVal)).toThrow(/arg\[2\]/);
  });

  it("exposes the field and value on the error and never returns a partial ScVal", () => {
    let thrown: unknown;
    let produced: unknown;
    try {
      produced = toScVal({ ok: 1, bad: U32_MAX + 1 }, "payload");
    } catch (err) {
      thrown = err;
    }

    expect(produced).toBeUndefined();
    expect(thrown).toBeInstanceOf(ScValRangeError);
    expect((thrown as ScValRangeError).field).toBe("payload.bad");
    expect((thrown as ScValRangeError).value).toBe(U32_MAX + 1);
  });

  it("an out-of-range argument fails the client call before anything is sent", async () => {
    await expect(new SLACalculatorClient({ contractId: "C", networkPassphrase: "t", rpcUrl: "x" }).getHistoryPage(0, U32_MAX + 1)).rejects.toThrow(
      /arg\[1\]/,
    );
  });
});
