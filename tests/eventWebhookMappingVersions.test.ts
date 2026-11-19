import { describe, it, expect } from "vitest";
import {
  CURRENT_EVENT_VERSION,
  mapWebhookEvent,
  type LegacyVersionTable,
} from "../offchain/eventWebhookMapping";

describe("#1057 webhook event version mapping", () => {
  it("maps a known current event", () => {
    const r = mapWebhookEvent({ event: "SlaCalculated", version: CURRENT_EVENT_VERSION });

    expect(r).toMatchObject({ kind: "mapped", legacy: false, canonicalEvent: "SlaCalculated" });
    if (r.kind === "mapped") expect(r.mapping.topic).toBe("sla.calculated");
  });

  it("reports a future version as unsupported, keeping the original topic and version", () => {
    const r = mapWebhookEvent({ event: "SlaCalculated", version: "v2" });

    expect(r).toEqual({ kind: "unsupported", reason: "unknown_version", topic: "SlaCalculated", version: "v2" });
  });

  it("does not silently map a future version to the current event of the same name", () => {
    const r = mapWebhookEvent({ event: "PayoutInitiated", version: "v99" });

    expect(r.kind).toBe("unsupported");
  });

  it("reports an unknown event of a known version as unsupported with the original values", () => {
    const r = mapWebhookEvent({ event: "NotAnEvent", version: "v1" });

    expect(r).toEqual({ kind: "unsupported", reason: "unknown_event", topic: "NotAnEvent", version: "v1" });
  });

  it("treats an empty or differently cased version as unknown", () => {
    for (const version of ["", "V1", "1", "v1 "]) {
      expect(mapWebhookEvent({ event: "SlaCalculated", version }).kind).toBe("unsupported");
    }
  });

  it("maps a documented legacy version to the canonical event model", () => {
    const legacy: LegacyVersionTable = { v0: { sla_calc: "SlaCalculated", cfg_upd: "ConfigUpdated" } };

    const r = mapWebhookEvent({ event: "sla_calc", version: "v0" }, legacy);

    expect(r).toMatchObject({ kind: "mapped", legacy: true, canonicalEvent: "SlaCalculated" });
  });

  it("reports an event missing from a known legacy version as unsupported", () => {
    const legacy: LegacyVersionTable = { v0: { sla_calc: "SlaCalculated" } };

    expect(mapWebhookEvent({ event: "mystery", version: "v0" }, legacy)).toEqual({
      kind: "unsupported",
      reason: "unknown_event",
      topic: "mystery",
      version: "v0",
    });
  });

  it("does not treat prototype property names as versions or events", () => {
    expect(mapWebhookEvent({ event: "SlaCalculated", version: "constructor" }).kind).toBe("unsupported");
    expect(mapWebhookEvent({ event: "toString", version: "v0" }, { v0: {} }).kind).toBe("unsupported");
  });
});
