import { describe, it, expect } from "vitest";
import { decodeOutageEvent, decodePaymentEvent } from "../offchain/outagePaymentEventFields";

// Fixtures: the current event shape and what older contract versions omitted.
const CURRENT_PAYMENT = {
  outageId: "OUT001",
  amount: 750,
  currency: "XLM",
  initiatedAt: 1_700_000_000,
  correlationId: "us-east-OUT001-1700000000",
};
const LEGACY_PAYMENT_NO_CORRELATION = { outageId: "OUT002", amount: 100, currency: "XLM", initiatedAt: 1_600_000_000 };
const LEGACY_PAYMENT_MINIMAL = { outageId: "OUT003", amount: 5 };

const CURRENT_OUTAGE = {
  outageId: "OUT001",
  region: "us-east",
  startedAt: 1_699_999_000,
  resolvedAt: 1_700_000_000,
  correlationId: "us-east-OUT001-1700000000",
};
const LEGACY_OUTAGE = { outageId: "OUT004", region: "eu-west", startedAt: 1_500_000_000 };

describe("#1061 payment event decoding", () => {
  it("preserves every correlation field of a current event", () => {
    expect(decodePaymentEvent(CURRENT_PAYMENT)).toEqual({ ...CURRENT_PAYMENT, legacy: false });
  });

  it("decodes a legacy event with an explicit absent correlation id and does not fabricate one", () => {
    const decoded = decodePaymentEvent(LEGACY_PAYMENT_NO_CORRELATION);

    expect(decoded.correlationId).toBeNull();
    expect(decoded.legacy).toBe(true);
    expect(decoded.outageId).toBe("OUT002");
    expect(decoded.amount).toBe(100);
  });

  it("reports every absent optional field as null for a minimal legacy event", () => {
    expect(decodePaymentEvent(LEGACY_PAYMENT_MINIMAL)).toEqual({
      outageId: "OUT003",
      amount: 5,
      currency: null,
      initiatedAt: null,
      correlationId: null,
      legacy: true,
    });
  });

  it("treats explicit nulls like absent fields", () => {
    expect(decodePaymentEvent({ ...CURRENT_PAYMENT, correlationId: null }).correlationId).toBeNull();
  });

  it("keeps a zero amount and a zero timestamp rather than treating them as absent", () => {
    const decoded = decodePaymentEvent({ outageId: "OUT005", amount: 0, initiatedAt: 0, correlationId: "c", currency: "XLM" });

    expect(decoded.amount).toBe(0);
    expect(decoded.initiatedAt).toBe(0);
    expect(decoded.legacy).toBe(false);
  });

  it("rejects an event without the required fields", () => {
    expect(() => decodePaymentEvent({ amount: 1 })).toThrow(/outageId/);
    expect(() => decodePaymentEvent({ outageId: "O" })).toThrow(/amount/);
  });

  it("rejects an optional field that is present with the wrong type instead of guessing", () => {
    expect(() => decodePaymentEvent({ ...CURRENT_PAYMENT, correlationId: 42 })).toThrow(/correlationId/);
    expect(() => decodePaymentEvent({ ...CURRENT_PAYMENT, initiatedAt: "yesterday" })).toThrow(/initiatedAt/);
  });
});

describe("#1061 outage event decoding", () => {
  it("preserves every field of a current event", () => {
    expect(decodeOutageEvent(CURRENT_OUTAGE)).toEqual({ ...CURRENT_OUTAGE, legacy: false });
  });

  it("decodes a legacy event with explicit absent values", () => {
    expect(decodeOutageEvent(LEGACY_OUTAGE)).toEqual({
      outageId: "OUT004",
      region: "eu-west",
      startedAt: 1_500_000_000,
      resolvedAt: null,
      correlationId: null,
      legacy: true,
    });
  });

  it("an unresolved outage with a correlation id is not legacy just because resolvedAt is absent", () => {
    const { resolvedAt: _omit, ...unresolved } = CURRENT_OUTAGE;

    const decoded = decodeOutageEvent(unresolved);

    expect(decoded.resolvedAt).toBeNull();
    expect(decoded.legacy).toBe(false);
  });

  it("rejects an event without an outage id", () => {
    expect(() => decodeOutageEvent({ region: "x" })).toThrow(/outageId/);
  });
});
