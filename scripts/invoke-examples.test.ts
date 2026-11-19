import { describe, it, expect } from "vitest";
import { redactSecrets, formatFailure, buildCommand } from "./invoke-examples";

const SEED = "S" + "A".repeat(55);
const PUB = "G" + "B".repeat(55);

describe("redactSecrets", () => {
  it("removes a secret seed from a simulated failure", () => {
    const out = redactSecrets(`error: bad signer ${SEED} rejected`);
    expect(out).not.toContain(SEED);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts the configured secret and flag values but keeps public keys", () => {
    const cmd = `soroban contract invoke --id CABC --source-account ${SEED} -- f --caller ${PUB}`;
    const out = redactSecrets(cmd, SEED);
    expect(out).not.toContain(SEED);
    expect(out).toContain(PUB);
    expect(out).toContain("--id CABC");
  });

  it("redacts secret-looking assignments", () => {
    expect(redactSecrets("SOURCE_SECRET=hunter2hunter2 ok")).toBe("SOURCE_SECRET=[REDACTED] ok");
  });
});

describe("formatFailure", () => {
  it("keeps function, network and contract context while sanitizing", () => {
    const out = formatFailure("calculate_sla", `HostError ${SEED}`, "testnet", "CABC");
    expect(out).toContain("fn=calculate_sla");
    expect(out).toContain("network=testnet");
    expect(out).toContain("contract=CABC");
    expect(out).not.toContain(SEED);
  });
});

describe("buildCommand", () => {
  it("includes the function and arguments", () => {
    const c = buildCommand("get_stats", { x: "1" }, { contractId: "CABC", source: "alice", network: "testnet" });
    expect(c).toContain("-- get_stats --x 1");
  });
});
