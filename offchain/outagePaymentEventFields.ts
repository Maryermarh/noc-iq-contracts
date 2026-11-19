export interface OutageEvent {
  outageId: string;
  region: string;
  startedAt: number;
  resolvedAt?: number;
  correlationId: string;
}

export interface PaymentEvent {
  outageId: string;
  amount: number;
  currency: string;
  initiatedAt: number;
  correlationId: string;
}

export function buildCorrelationId(outageId: string, region: string, ts = Date.now()): string {
  return `${region}-${outageId}-${ts}`;
}

export function linkPaymentToOutage(outage: OutageEvent, payment: PaymentEvent): boolean {
  return outage.outageId === payment.outageId && outage.correlationId === payment.correlationId;
}

export function validateTraceFields(event: OutageEvent | PaymentEvent): string[] {
  const missing: string[] = [];
  if (!event.outageId)      missing.push("outageId");
  if (!event.correlationId) missing.push("correlationId");
  return missing;
}

// ---------------------------------------------------------------------------
// #1061: decoding events from older contract versions
// ---------------------------------------------------------------------------

/** A payment event as decoded from any contract version; absent optional fields are explicit `null`s. */
export interface DecodedPaymentEvent {
  outageId: string;
  amount: number;
  currency: string | null;
  initiatedAt: number | null;
  /** Never fabricated: `null` when the source event predates the field. */
  correlationId: string | null;
  /** True when at least one optional field was absent. */
  legacy: boolean;
}

export interface DecodedOutageEvent {
  outageId: string;
  region: string | null;
  startedAt: number | null;
  resolvedAt: number | null;
  correlationId: string | null;
  legacy: boolean;
}

function requireField<T>(raw: Record<string, unknown>, key: string, type: "string" | "number"): T {
  const v = raw[key];
  if (typeof v !== type) throw new TypeError(`[#1061] required field "${key}" must be a ${type}`);
  return v as T;
}

function optionalField<T>(raw: Record<string, unknown>, key: string, type: "string" | "number"): T | null {
  const v = raw[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== type) throw new TypeError(`[#1061] optional field "${key}" must be a ${type} when present`);
  return v as T;
}

/**
 * Decodes a payment event. `outageId` and `amount` are required in every version; the rest may be
 * missing from older events and are then reported as `null`, never invented (in particular, a
 * missing correlation id is not rebuilt with {@link buildCorrelationId}).
 */
export function decodePaymentEvent(raw: Record<string, unknown>): DecodedPaymentEvent {
  const currency = optionalField<string>(raw, "currency", "string");
  const initiatedAt = optionalField<number>(raw, "initiatedAt", "number");
  const correlationId = optionalField<string>(raw, "correlationId", "string");
  return {
    outageId: requireField<string>(raw, "outageId", "string"),
    amount: requireField<number>(raw, "amount", "number"),
    currency,
    initiatedAt,
    correlationId,
    legacy: currency === null || initiatedAt === null || correlationId === null,
  };
}

/** Decodes an outage event; only `outageId` is required in every version. */
export function decodeOutageEvent(raw: Record<string, unknown>): DecodedOutageEvent {
  const region = optionalField<string>(raw, "region", "string");
  const startedAt = optionalField<number>(raw, "startedAt", "number");
  const resolvedAt = optionalField<number>(raw, "resolvedAt", "number");
  const correlationId = optionalField<string>(raw, "correlationId", "string");
  return {
    outageId: requireField<string>(raw, "outageId", "string"),
    region,
    startedAt,
    resolvedAt,
    correlationId,
    legacy: region === null || startedAt === null || correlationId === null,
  };
}
