export type ContractEvent = string;
export type WebhookTopic  = string;

export interface WebhookMapping {
  event: ContractEvent;
  topic: WebhookTopic;
  version: string;
  compatible: boolean;
}

export const eventWebhookMappings: WebhookMapping[] = [
  { event: "OutageRegistered",       topic: "outage.created",    version: "v1", compatible: true },
  { event: "SlaCalculated",          topic: "sla.calculated",    version: "v1", compatible: true },
  { event: "ConfigUpdated",          topic: "config.changed",    version: "v1", compatible: true },
  { event: "GovernanceActionEmitted",topic: "governance.action", version: "v1", compatible: true },
  { event: "PayoutInitiated",        topic: "payment.initiated", version: "v1", compatible: true },
];

export function validateMapping(event: ContractEvent): WebhookMapping | undefined {
  return eventWebhookMappings.find((m) => m.event === event);
}

export function incompatibleMappings(): WebhookMapping[] {
  return eventWebhookMappings.filter((m) => !m.compatible);
}

// ---------------------------------------------------------------------------
// #1057: version-aware mapping that preserves unknown versions for diagnostics
// ---------------------------------------------------------------------------

/** The only event version the contract emits today (`EVENT_VERSION` in event_schema.rs). */
export const CURRENT_EVENT_VERSION = "v1";

/** Older event versions the indexer still decodes: version -> (event name in that version -> canonical event). */
export type LegacyVersionTable = Record<string, Record<ContractEvent, ContractEvent>>;

/** No older version has been emitted by a deployed contract, so none is documented yet. */
export const LEGACY_EVENT_VERSIONS: LegacyVersionTable = {};

export interface WebhookEventInput {
  /** The event name as received (topic[0]). */
  event: ContractEvent;
  /** The event version as received (topic[1]). */
  version: string;
}

export type WebhookMapResult =
  | { kind: "mapped"; mapping: WebhookMapping; canonicalEvent: ContractEvent; legacy: boolean }
  | {
      kind: "unsupported";
      reason: "unknown_version" | "unknown_event";
      /** Exactly what was received, so it can be logged and diagnosed. */
      topic: ContractEvent;
      version: string;
    };

/**
 * Maps a received event to its canonical webhook mapping. A version the indexer does not know is
 * reported as `unsupported` with the original topic and version; it is never mapped to the
 * current event of the same name.
 */
export function mapWebhookEvent(
  input: WebhookEventInput,
  legacyVersions: LegacyVersionTable = LEGACY_EVENT_VERSIONS
): WebhookMapResult {
  const unsupported = (reason: "unknown_version" | "unknown_event"): WebhookMapResult => ({
    kind: "unsupported",
    reason,
    topic: input.event,
    version: input.version,
  });

  if (input.version === CURRENT_EVENT_VERSION) {
    const mapping = eventWebhookMappings.find((m) => m.event === input.event && m.version === CURRENT_EVENT_VERSION);
    return mapping ? { kind: "mapped", mapping, canonicalEvent: mapping.event, legacy: false } : unsupported("unknown_event");
  }

  const aliases = Object.prototype.hasOwnProperty.call(legacyVersions, input.version) ? legacyVersions[input.version] : undefined;
  if (!aliases) return unsupported("unknown_version");

  const canonical = Object.prototype.hasOwnProperty.call(aliases, input.event) ? aliases[input.event] : undefined;
  const mapping = canonical === undefined ? undefined : eventWebhookMappings.find((m) => m.event === canonical && m.version === CURRENT_EVENT_VERSION);
  return mapping ? { kind: "mapped", mapping, canonicalEvent: mapping.event, legacy: true } : unsupported("unknown_event");
}
