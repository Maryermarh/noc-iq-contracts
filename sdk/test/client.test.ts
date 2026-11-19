import { describe, it, expect, vi } from "vitest";
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

import { CANCELLED_ERROR_CODE, RpcResponse } from "../src/client";
import { CursorValidationError, MAX_CURSOR_LENGTH, decodeHistoryRequest, encodeHistoryRequest } from "../src/cursor";

function clientWith(transport: (req: any, signal?: any) => Promise<RpcResponse>, retry = { maxAttempts: 3, baseDelayMs: 1 }) {
  return new SLACalculatorClient({
    contractId: "CABC1234567890ABCDEF",
    networkPassphrase: "Testnet ; SDF Network ; September 2015",
    rpcUrl: "https://example.invalid",
    transport,
    retry,
  });
}

/** Minimal AbortController stand-in (the SDK is built without the DOM lib). */
function controller() {
  const listeners = new Set<() => void>();
  const signal = {
    aborted: false,
    addEventListener: (_t: "abort", l: () => void) => listeners.add(l),
    removeEventListener: (_t: "abort", l: () => void) => listeners.delete(l),
  };
  return {
    signal,
    abort() {
      signal.aborted = true;
      [...listeners].forEach((l) => l());
    },
  };
}

describe("cancellation and retry (issue #1069)", () => {
  it("an abort stops an in-flight request immediately with a typed cancelled result", async () => {
    const c = controller();
    const transport = vi.fn(() => new Promise<RpcResponse>(() => undefined)); // never settles
    const client = clientWith(transport).withSignal(c.signal);

    const pending = client.getAdmin();
    c.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, cancelled: true, errorCode: CANCELLED_ERROR_CODE });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("an aborted request is never retried, even when the transport fails with a transient error", async () => {
    const c = controller();
    const transport = vi.fn(async () => {
      c.abort();
      throw new Error("socket hang up");
    });

    const result = await clientWith(transport).withSignal(c.signal).getAdmin();

    expect(result.cancelled).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("an AbortError from the transport is a cancellation, not a retryable failure", async () => {
    const transport = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const result = await clientWith(transport).getAdmin();
    expect(result.cancelled).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not start a request when the signal is already aborted", async () => {
    const c = controller();
    c.abort();
    const transport = vi.fn(async (): Promise<RpcResponse> => ({ status: 200, value: "x" }));

    const result = await clientWith(transport).withSignal(c.signal).getAdmin();

    expect(result.cancelled).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });

  it("an abort during backoff ends the wait without another attempt", async () => {
    const c = controller();
    const transport = vi.fn(async (): Promise<RpcResponse> => ({ status: 503 }));
    const client = clientWith(transport, { maxAttempts: 5, baseDelayMs: 60_000 }).withSignal(c.signal);

    const pending = client.getAdmin();
    await Promise.resolve();
    await Promise.resolve();
    c.abort();

    await expect(pending).resolves.toMatchObject({ cancelled: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("still retries transient failures: network errors and 5xx, up to maxAttempts", async () => {
    let calls = 0;
    const transport = vi.fn(async (): Promise<RpcResponse> => {
      calls += 1;
      if (calls === 1) throw new Error("ECONNRESET");
      if (calls === 2) return { status: 503 };
      return { status: 200, value: "GADMIN" };
    });

    const result = await clientWith(transport).getAdmin();

    expect(result).toEqual({ ok: true, value: "GADMIN" });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxAttempts and reports the last failure", async () => {
    const transport = vi.fn(async (): Promise<RpcResponse> => ({ status: 503, error: "upstream down" }));

    const result = await clientWith(transport, { maxAttempts: 2, baseDelayMs: 1 }).getAdmin();

    expect(result).toMatchObject({ ok: false, error: "upstream down" });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("does not retry a definitive failure such as a contract error", async () => {
    const transport = vi.fn(async (): Promise<RpcResponse> => ({ status: 200, error: "x", contractErrorCode: 3 }));

    const result = await clientWith(transport).pause("G", "r");

    expect(result).toMatchObject({ ok: false, errorCode: "Unauthorized", contractErrorCode: 3 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("history cursor validation (issue #1070)", () => {
  const goodCursor = "eyJvIjoxMjN9_-abc";

  it("valid cursors round-trip through request encoding", () => {
    const args = encodeHistoryRequest({ cursor: goodCursor, limit: 25 });
    expect(args).toEqual([goodCursor, 25]);
    expect(decodeHistoryRequest(args)).toEqual({ cursor: goodCursor, limit: 25 });
    expect(decodeHistoryRequest(encodeHistoryRequest({ limit: 10 }))).toEqual({ limit: 10 });
  });

  it("malformed and oversized cursors are rejected before any network access", async () => {
    const transport = vi.fn(async (): Promise<RpcResponse> => ({ status: 200, value: [] }));
    const client = clientWith(transport);

    for (const cursor of ["", "has space", "semi;colon", "a/b+c==", "x".repeat(MAX_CURSOR_LENGTH + 1)]) {
      await expect(client.getHistoryPageByCursor({ cursor, limit: 10 })).rejects.toBeInstanceOf(CursorValidationError);
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it("the boundary length is accepted", () => {
    expect(() => encodeHistoryRequest({ cursor: "a".repeat(MAX_CURSOR_LENGTH), limit: 1 })).not.toThrow();
  });

  it("explains what is wrong", () => {
    expect(() => encodeHistoryRequest({ cursor: "bad cursor", limit: 5 })).toThrow(/letters, digits/);
    expect(() => encodeHistoryRequest({ cursor: "x".repeat(300), limit: 5 })).toThrow(/longer than the maximum/);
    expect(() => encodeHistoryRequest({ cursor: "ok", limit: 0 })).toThrow(/positive integer/);
  });

  it("a valid cursor is sent to the transport as contract arguments", async () => {
    const transport = vi.fn(async (): Promise<RpcResponse> => ({ status: 200, value: [] }));

    await clientWith(transport).getHistoryPageByCursor({ cursor: goodCursor, limit: 5 });

    expect(transport.mock.calls[0][0]).toMatchObject({ method: "get_history_page_cursor" });
  });
});
