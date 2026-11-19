/**
 * Unit tests for the post-deploy smoke verification runner.
 */

import { describe, it, expect } from "vitest";
import { runSmokeVerification, ContractClient } from "./post-deploy-smoke";

function healthyClient(): ContractClient {
  return {
    async getAdmin() {
      return "GADMIN123456789";
    },
    async getOperator() {
      return "GOPER123456789";
    },
    async isPaused() {
      return false;
    },
    async getConfig(severity: string) {
      return {
        threshold_minutes:
          { critical: 15, high: 30, medium: 60, low: 120 }[severity] ?? 0,
      };
    },
    async getStats() {
      return { total_calculations: 10 };
    },
    async getConfigSnapshot() {
      return { version: "v1", entries: [{}, {}, {}, {}] };
    },
  };
}

describe("runSmokeVerification", () => {
  it("passes every check against a healthy contract", async () => {
    const results = await runSmokeVerification(healthyClient());
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it("flags a paused contract as a failing check", async () => {
    const client = healthyClient();
    client.isPaused = async () => true;
    const results = await runSmokeVerification(client);
    const pausedCheck = results.find((r) => r.check === "contract is not paused");
    expect(pausedCheck?.passed).toBe(false);
  });

  it("flags a missing admin address as a failing check", async () => {
    const client = healthyClient();
    client.getAdmin = async () => "";
    const results = await runSmokeVerification(client);
    const adminCheck = results.find((r) => r.check === "admin address is set");
    expect(adminCheck?.passed).toBe(false);
  });

  it("flags an invalid threshold as a failing check", async () => {
    const client = healthyClient();
    client.getConfig = async () => ({ threshold_minutes: 0 });
    const results = await runSmokeVerification(client);
    expect(results.some((r) => !r.passed)).toBe(true);
  });

  it("records a failure detail when a client call rejects, without throwing", async () => {
    const client = healthyClient();
    client.getStats = async () => {
      throw new Error("RPC unreachable");
    };
    const results = await runSmokeVerification(client);
    const statsCheck = results.find((r) => r.check === "stats are readable");
    expect(statsCheck?.passed).toBe(false);
    expect(statsCheck?.detail).toContain("RPC unreachable");
  });
});

describe("read-before-write ordering and write-probe gating", () => {
  function probeClient(log: string[]): ContractClient {
    const c = healthyClient();
    const origPaused = c.isPaused.bind(c);
    c.isPaused = async () => {
      log.push("isPaused");
      return origPaused();
    };
    c.writeProbe = async () => {
      log.push("write");
      return "probe ok";
    };
    return c;
  }

  it("does not run write probes unless opted in", async () => {
    const log: string[] = [];
    await runSmokeVerification(probeClient(log));
    expect(log).not.toContain("write");
  });

  it("runs health first and the write probe last when opted in", async () => {
    const log: string[] = [];
    const results = await runSmokeVerification(probeClient(log), {
      writeProbes: true,
      network: "TESTNET",
    });
    expect(log[0]).toBe("isPaused");
    expect(log[log.length - 1]).toBe("write");
    expect(results[0].phase).toBe("read");
    expect(results[results.length - 1].phase).toBe("write");
  });

  it("refuses write probes on mainnet by default", async () => {
    const log: string[] = [];
    const results = await runSmokeVerification(probeClient(log), {
      writeProbes: true,
      network: "MAINNET",
    });
    expect(log).not.toContain("write");
    const last = results[results.length - 1];
    expect(last.skipped).toBe(true);
    expect(last.passed).toBe(false);
  });

  it("skips the write probe when a read check failed", async () => {
    const log: string[] = [];
    const c = probeClient(log);
    c.isPaused = async () => true;
    const results = await runSmokeVerification(c, { writeProbes: true, network: "TESTNET" });
    expect(log).not.toContain("write");
    expect(results[results.length - 1].skipped).toBe(true);
  });
});
