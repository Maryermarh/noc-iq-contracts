/**
 * TypeScript definition generator.
 *
 * Converts a parsed contract spec (structs + functions, the same shape
 * `SLACalculatorClient.loadContractSpec()` returns) into formatted
 * TypeScript declarations, so SDK type definitions can be regenerated
 * automatically when the contract's function signatures change instead
 * of being hand-edited.
 */

export interface TypeGenField {
  name: string;
  tsType: string;
}

export interface TypeGenStruct {
  name: string;
  fields: TypeGenField[];
}

export interface TypeGenFunction {
  name: string;
  params: TypeGenField[];
  returns: string;
}

/** A contract event and the TypeScript shape of its payload tuple (positional order matters). */
export interface TypeGenEvent {
  /** Event symbol, e.g. `sla_calc`. */
  name: string;
  /** Payload fields in tuple order. `undefined` means the event has no TypeScript representation. */
  payload?: TypeGenField[];
}

export interface TypeGenSpec {
  structs?: TypeGenStruct[];
  functions?: TypeGenFunction[];
  /** TypeScript representations of contract events. */
  events?: TypeGenEvent[];
  /**
   * Names of every event the contract exports. When given, each one must have an entry in
   * `events` with a payload, otherwise generation fails (see {@link MissingEventSchemaError}).
   */
  exportedEvents?: string[];
}

/** Thrown when an exported contract event has no TypeScript representation. */
export class MissingEventSchemaError extends Error {
  constructor(readonly events: string[]) {
    super(
      `No TypeScript schema for exported contract event(s): ${events.join(", ")}. ` +
        "Add an entry to the spec's `events` (with a payload) or document the payload in sla_calculator/src/event_schema.rs.",
    );
    this.name = "MissingEventSchemaError";
  }
}

/** Converts a snake_case contract function name to camelCase for TS. */
function toCamelCase(snakeCase: string): string {
  return snakeCase.replace(/_([a-z0-9])/g, (_match, char: string) =>
    char.toUpperCase(),
  );
}

/** Locale-independent ordering: plain UTF-16 code unit comparison. */
function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** `sla_calc` -> `SlaCalc`, used to name event payload interfaces. */
function toPascalCase(snakeCase: string): string {
  const camel = toCamelCase(snakeCase);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * Ordering rule (issue #1072). The same contract metadata must always produce byte-identical
 * output, whatever order the metadata lists its items in:
 *  - structs, functions and events are emitted sorted by name (ascending, code-unit order);
 *  - struct fields are sorted by name;
 *  - function parameters and event payload fields keep their positional order, because position is
 *    part of the contract ABI.
 */
function normalizeSpec(spec: TypeGenSpec): Required<Pick<TypeGenSpec, "structs" | "functions" | "events">> {
  return {
    structs: [...(spec.structs ?? [])]
      .map((s) => ({ ...s, fields: [...s.fields].sort(byName) }))
      .sort(byName),
    functions: [...(spec.functions ?? [])].sort(byName),
    events: [...(spec.events ?? [])].sort(byName),
  };
}

/**
 * Generates formatted TypeScript interface and function declarations from
 * a contract spec. Pure string generation — writing the result to disk is
 * the caller's responsibility (see `sdk/scripts/generate-types.ts`). Output order is documented
 * on {@link normalizeSpec} and is independent of input order.
 *
 * @throws {MissingEventSchemaError} when `spec.exportedEvents` lists an event without a payload mapping.
 */
export function generateTypeDefinitions(spec: TypeGenSpec): string {
  const { structs, functions, events } = normalizeSpec(spec);

  if (spec.exportedEvents) {
    const mapped = new Set(events.filter((e) => e.payload !== undefined).map((e) => e.name));
    const missing = [...new Set(spec.exportedEvents)].filter((name) => !mapped.has(name)).sort();
    if (missing.length > 0) throw new MissingEventSchemaError(missing);
  }

  const lines: string[] = [
    "// AUTO-GENERATED — do not edit by hand.",
    "// Regenerate with `npm run generate:types` from the live contract spec.",
    "",
  ];

  for (const struct of structs) {
    lines.push(`export interface ${struct.name} {`);
    for (const field of struct.fields) {
      lines.push(`  ${field.name}: ${field.tsType};`);
    }
    lines.push("}", "");
  }

  for (const event of events) {
    if (event.payload === undefined) continue;
    lines.push(`/** Payload of the \`${event.name}\` event (tuple order). */`);
    lines.push(`export interface ${toPascalCase(event.name)}EventPayload {`);
    for (const field of event.payload) {
      lines.push(`  ${field.name}: ${field.tsType};`);
    }
    lines.push("}", "");
  }
  if (events.some((e) => e.payload !== undefined)) {
    const names = events.filter((e) => e.payload !== undefined).map((e) => JSON.stringify(e.name));
    lines.push(`export type ContractEventName = ${names.join(" | ")};`, "");
  }

  for (const fn of functions) {
    const params = fn.params
      .map((p) => `${p.name}: ${p.tsType}`)
      .join(", ");
    lines.push(
      `export declare function ${toCamelCase(fn.name)}(${params}): Promise<${fn.returns}>;`,
    );
  }

  return lines.join("\n") + "\n";
}
