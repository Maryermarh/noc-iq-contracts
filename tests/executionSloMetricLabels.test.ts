import { describe, it, expect } from "vitest";
import {
  ALLOWED_FAILURES,
  ALLOWED_ROUTES,
  MAX_LABEL_COMBINATIONS,
  buildMetricLabels,
  type ExecutionSloSignal,
} from "../offchain/executionSloSignals";

const signal = (over: Partial<ExecutionSloSignal> = {}): ExecutionSloSignal => ({
  contractId: "CABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW",
  method: "calculate_sla",
  p50Ms: 10,
  p95Ms: 20,
  p99Ms: 30,
  errorRate: 0,
  ...over,
});

const TX_HASH = "a".repeat(64);

describe("#1058 SLO metric labels", () => {
  it("keeps an allowlisted route and failure and reports the SLO status", () => {
    expect(buildMetricLabels(signal({ failure: "timeout" }))).toEqual({
      route: "calculate_sla",
      failure: "timeout",
      status: "healthy",
    });
  });

  it("uses failure=none when the call did not fail", () => {
    expect(buildMetricLabels(signal()).failure).toBe("none");
  });

  it("normalizes case and surrounding whitespace for allowlisted values", () => {
    const labels = buildMetricLabels(signal({ method: " GET_HISTORY ", failure: "Unauthorized" }));

    expect(labels.route).toBe("get_history");
    expect(labels.failure).toBe("unauthorized");
  });

  it("collapses an unknown route to other", () => {
    expect(buildMetricLabels(signal({ method: "drop_everything" })).route).toBe("other");
  });

  it("never lets a transaction hash, contract ID or free-form message into a label", () => {
    const labels = buildMetricLabels(
      signal({ method: TX_HASH, failure: "Error: balance of GABC123 below 500 (tx " + TX_HASH + ")" }),
    );

    const values = Object.values(labels).join("|");
    expect(values).not.toContain(TX_HASH);
    expect(values).not.toContain("GABC123");
    expect(values).not.toContain("CABCDEFG");
    expect(labels.route).toBe("other");
    expect(labels.failure).toBe("other");
  });

  it("does not use the contract ID as a label key or value", () => {
    const s = signal();

    const labels = buildMetricLabels(s);

    expect(Object.keys(labels)).toEqual(["route", "failure", "status"]);
    expect(JSON.stringify(labels)).not.toContain(s.contractId);
  });

  it("reflects a breached SLO in the status label", () => {
    expect(buildMetricLabels(signal({ p99Ms: 5_000 })).status).toBe("breached");
  });

  it("bounds the number of distinct label combinations", () => {
    const seen = new Set<string>();
    const methods = [...ALLOWED_ROUTES, "x1", "x2", TX_HASH, "", "CALCULATE_SLA "];
    const failures = [undefined, ...ALLOWED_FAILURES, "y1", "y2", TX_HASH, "free text"];
    const p99s = [1, 600, 5_000];
    for (const method of methods)
      for (const failure of failures)
        for (const p99Ms of p99s) {
          seen.add(JSON.stringify(buildMetricLabels(signal({ method, failure, p99Ms }))));
        }

    expect(seen.size).toBeLessThanOrEqual(MAX_LABEL_COMBINATIONS);
  });
});
