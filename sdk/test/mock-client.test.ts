import { describe, it, expect } from "vitest";
import { MockSlaCalculatorClient } from "../src/mock-client";

describe("MockSlaCalculatorClient", () => {
  it("returns the default stub response when no mock is configured", async () => {
    const client = new MockSlaCalculatorClient();
    const result = await client.isPaused();
    expect(result.ok).toBe(true);
  });

  it("returns a configured mock value for a given method", async () => {
    const client = new MockSlaCalculatorClient();
    client.mockResponse("get_admin", { value: "GADMIN123" });
    const result = await client.getAdmin();
    expect(result.ok).toBe(true);
    expect(result.value).toBe("GADMIN123");
  });

  it("returns a configured mock error for a given method", async () => {
    const client = new MockSlaCalculatorClient();
    client.mockResponse("get_admin", { error: "not initialized" });
    const result = await client.getAdmin();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not initialized");
  });

  it("records call history with method name and arguments", async () => {
    const client = new MockSlaCalculatorClient();
    await client.calculateSla("op1", "outage-1", "high", 42);
    expect(client.calls).toEqual([
      { method: "calculate_sla", args: ["op1", "outage-1", "high", 42] },
    ]);
  });

  it("records multiple calls in order", async () => {
    const client = new MockSlaCalculatorClient();
    await client.getAdmin();
    await client.getOperator();
    expect(client.calls.map((c) => c.method)).toEqual([
      "get_admin",
      "get_operator",
    ]);
  });

  it("reset() clears both mock responses and call history", async () => {
    const client = new MockSlaCalculatorClient();
    client.mockResponse("get_admin", { value: "GADMIN123" });
    await client.getAdmin();
    client.reset();

    expect(client.calls).toEqual([]);
    const result = await client.getAdmin();
    // Falls back to the default stub, not the cleared mock value.
    expect(result.value).not.toBe("GADMIN123");
  });
});

describe("MockSlaCalculatorClient state isolation (issue #1075)", () => {
  it("two instances begin from independent state", async () => {
    const a = new MockSlaCalculatorClient();
    const b = new MockSlaCalculatorClient();
    a.mockResponse("get_admin", { value: "GA" });
    await a.getAdmin();

    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(0);
    expect((await b.getAdmin()).value).toBeUndefined();
    expect((await a.getAdmin()).value).toBe("GA");
  });

  it("changes stay local: configuring and calling one instance never affects another", async () => {
    const a = new MockSlaCalculatorClient();
    const b = new MockSlaCalculatorClient();
    b.mockResponse("get_admin", { error: "boom" });

    expect((await a.getAdmin()).ok).toBe(true);
    expect((await b.getAdmin()).ok).toBe(false);
    expect(a.calls).not.toBe(b.calls);
  });

  it("resetting one instance does not clear the other instance's fixture data", async () => {
    const a = new MockSlaCalculatorClient();
    const b = new MockSlaCalculatorClient();
    a.mockResponse("get_admin", { value: "GA" });
    b.mockResponse("get_admin", { value: "GB" });
    await b.getAdmin();

    a.reset();

    expect(a.calls).toHaveLength(0);
    expect((await a.getAdmin()).value).toBeUndefined();
    expect((await b.getAdmin()).value).toBe("GB");
    expect(b.calls).toHaveLength(2);
  });

  it("parallel calls on separate instances do not interleave their histories", async () => {
    const instances = Array.from({ length: 5 }, () => new MockSlaCalculatorClient());

    await Promise.all(instances.map((client, i) => client.calculateSla(`op${i}`, `outage-${i}`, "high", i)));

    instances.forEach((client, i) => {
      expect(client.calls).toEqual([{ method: "calculate_sla", args: [`op${i}`, `outage-${i}`, "high", i] }]);
    });
  });

  it("a configured response is copied: mutating the original object afterwards has no effect", async () => {
    const client = new MockSlaCalculatorClient();
    const response = { value: "GA" as string | undefined };
    client.mockResponse("get_admin", response);

    response.value = "CHANGED";

    expect((await client.getAdmin()).value).toBe("GA");
  });

  it("instances do not share the default configuration object", () => {
    const a = new MockSlaCalculatorClient();
    const b = new MockSlaCalculatorClient();
    expect(a.contractAddress).toBe(b.contractAddress);
    expect((a as unknown as { config: object }).config).not.toBe((b as unknown as { config: object }).config);
  });
});
