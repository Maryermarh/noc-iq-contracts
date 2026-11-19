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

import { PROTECTED_METHODS } from "../src/mock-client";
import { SLACalculatorClient } from "../src/client";

describe("MockSlaCalculatorClient authorization parity (issue #1071)", () => {
  const ADMIN = "GADMIN";
  const OPERATOR = "GOPERATOR";
  const STRANGER = "GSTRANGER";

  function configured() {
    const client = new MockSlaCalculatorClient();
    client.setRoles(ADMIN, OPERATOR);
    return client;
  }

  it("lets the right role through and rejects every other caller, for each protected method", async () => {
    for (const [method, role] of Object.entries(PROTECTED_METHODS)) {
      const client = configured();
      const authorized = role === "admin" ? ADMIN : OPERATOR;
      const others = [role === "admin" ? OPERATOR : ADMIN, STRANGER];

      expect((await client.invokeMethod(method, [authorized])).ok).toBe(true);
      for (const caller of others) {
        const result = await client.invokeMethod(method, [caller]);
        expect({ method, caller, ok: result.ok, code: result.errorCode }).toEqual({
          method,
          caller,
          ok: false,
          code: "Unauthorized",
        });
      }
    }
  });

  it("an unauthorized call fails with the stable Unauthorized code (contract error #3)", async () => {
    const result = await configured().pause(STRANGER, "because");
    expect(result).toMatchObject({ ok: false, errorCode: "Unauthorized", contractErrorCode: 3 });
  });

  it("the generated client reports the same error identifiers for the same contract failure", async () => {
    const real = new SLACalculatorClient({
      contractId: "C1",
      networkPassphrase: "Test",
      rpcUrl: "x",
      transport: async () => ({ status: 200, error: "Error(Contract, #3)", contractErrorCode: 3 }),
    });

    const fromReal = await real.pause(STRANGER, "because");
    const fromMock = await configured().pause(STRANGER, "because");

    expect(fromMock.errorCode).toBe(fromReal.errorCode);
    expect(fromMock.contractErrorCode).toBe(fromReal.contractErrorCode);
    expect(fromMock.error).toBe(fromReal.error);
  });

  it("learns the roles from an initialize call and then enforces them", async () => {
    const client = new MockSlaCalculatorClient();
    await client.initialize(ADMIN, OPERATOR);

    expect((await client.calculateSla(STRANGER, "o1", "high", 5)).ok).toBe(false);
    expect((await client.calculateSla(OPERATOR, "o1", "high", 5)).ok).toBe(true);
  });

  it("does not enforce anything before roles are known (existing behaviour)", async () => {
    const client = new MockSlaCalculatorClient();
    expect((await client.pause("anyone", "r")).ok).toBe(true);
  });

  it("an unauthorized call does not reach a configured mock response", async () => {
    const client = configured();
    client.mockResponse("pause", { value: "ran" });

    const result = await client.pause(STRANGER, "r");

    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
  });
});
