import { describe, it, expect } from "vitest";
import { generateTypeDefinitions } from "../src/typegen";

describe("generateTypeDefinitions", () => {
  it("generates a valid-looking interface declaration for a struct", () => {
    const output = generateTypeDefinitions({
      structs: [
        {
          name: "SampleConfig",
          fields: [
            { name: "threshold_minutes", tsType: "number" },
            { name: "reward_base", tsType: "bigint" },
          ],
        },
      ],
    });

    expect(output).toContain("export interface SampleConfig {");
    expect(output).toContain("threshold_minutes: number;");
    expect(output).toContain("reward_base: bigint;");
    expect(output).toContain("}");
  });

  it("generates a camelCase function declaration from a snake_case name", () => {
    const output = generateTypeDefinitions({
      functions: [
        {
          name: "get_config",
          params: [{ name: "severity", tsType: "string" }],
          returns: "SampleConfig",
        },
      ],
    });

    expect(output).toContain(
      "export declare function getConfig(severity: string): Promise<SampleConfig>;",
    );
  });

  it("returns a header comment and stays well-formed with an empty spec", () => {
    const output = generateTypeDefinitions({});
    expect(output).toContain("AUTO-GENERATED");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("handles multiple structs and functions together", () => {
    const output = generateTypeDefinitions({
      structs: [
        { name: "A", fields: [{ name: "x", tsType: "number" }] },
        { name: "B", fields: [{ name: "y", tsType: "string" }] },
      ],
      functions: [
        { name: "do_thing", params: [], returns: "void" },
        {
          name: "do_other_thing",
          params: [{ name: "id", tsType: "string" }],
          returns: "A",
        },
      ],
    });

    expect(output).toContain("export interface A {");
    expect(output).toContain("export interface B {");
    expect(output).toContain(
      "export declare function doThing(): Promise<void>;",
    );
    expect(output).toContain(
      "export declare function doOtherThing(id: string): Promise<A>;",
    );
  });
});

import { readFileSync } from "fs";
import { join } from "path";
import { MissingEventSchemaError, TypeGenSpec } from "../src/typegen";
import { parseEventCatalog, UnmappedEventTypeError } from "../src/event-schema-doc";
import { buildSpec } from "../scripts/generate-types";

const SCHEMA_RS = join(__dirname, "..", "..", "sla_calculator", "src", "event_schema.rs");

describe("deterministic output (issue #1072)", () => {
  const spec: TypeGenSpec = {
    structs: [
      { name: "Zeta", fields: [{ name: "b", tsType: "number" }, { name: "a", tsType: "string" }] },
      { name: "Alpha", fields: [{ name: "x", tsType: "bigint" }] },
    ],
    functions: [
      { name: "set_config", params: [{ name: "caller", tsType: "string" }, { name: "cfg", tsType: "Zeta" }], returns: "void" },
      { name: "get_admin", params: [], returns: "string" },
    ],
    events: [
      { name: "sla_calc", payload: [{ name: "outage_id", tsType: "string" }, { name: "amount", tsType: "bigint" }] },
      { name: "paused", payload: [{ name: "value", tsType: "boolean" }] },
    ],
  };

  it("two runs produce byte-identical output", () => {
    expect(generateTypeDefinitions(spec)).toBe(generateTypeDefinitions(spec));
  });

  it("output does not depend on the order the metadata lists its items in", () => {
    const shuffled: TypeGenSpec = {
      structs: [...spec.structs!].reverse().map((s) => ({ ...s, fields: [...s.fields].reverse() })),
      functions: [...spec.functions!].reverse(),
      events: [...spec.events!].reverse(),
    };

    expect(generateTypeDefinitions(shuffled)).toBe(generateTypeDefinitions(spec));
  });

  it("orders structs, functions and events by name, and struct fields by name", () => {
    const out = generateTypeDefinitions(spec);

    expect(out.indexOf("interface Alpha")).toBeLessThan(out.indexOf("interface Zeta"));
    expect(out.indexOf("function getAdmin")).toBeLessThan(out.indexOf("function setConfig"));
    expect(out.indexOf("PausedEventPayload")).toBeLessThan(out.indexOf("SlaCalcEventPayload"));
    expect(out.indexOf("  a: string;")).toBeLessThan(out.indexOf("  b: number;"));
  });

  it("keeps positional order for function parameters and event payload fields", () => {
    const out = generateTypeDefinitions(spec);

    expect(out).toContain("setConfig(caller: string, cfg: Zeta)");
    expect(out.indexOf("outage_id: string;")).toBeLessThan(out.indexOf("amount: bigint;"));
  });

  it("the full generated output (placeholder spec + event catalog) is stable across runs", () => {
    const first = generateTypeDefinitions(buildSpec());
    const second = generateTypeDefinitions(buildSpec());
    expect(second).toBe(first);
  });
});

describe("missing event schema mappings (issue #1073)", () => {
  it("fails generation and names the event that has no mapping", () => {
    const spec: TypeGenSpec = {
      exportedEvents: ["sla_calc", "brand_new_event"],
      events: [{ name: "sla_calc", payload: [{ name: "amount", tsType: "bigint" }] }],
    };

    expect(() => generateTypeDefinitions(spec)).toThrow(MissingEventSchemaError);
    expect(() => generateTypeDefinitions(spec)).toThrow(/brand_new_event/);
  });

  it("an event listed without a payload counts as missing, and all missing events are named", () => {
    const spec: TypeGenSpec = {
      exportedEvents: ["a_evt", "b_evt", "c_evt"],
      events: [{ name: "a_evt", payload: [] }, { name: "b_evt" }],
    };

    try {
      generateTypeDefinitions(spec);
      throw new Error("expected generation to fail");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEventSchemaError);
      expect((err as MissingEventSchemaError).events).toEqual(["b_evt", "c_evt"]);
    }
  });

  it("an event with an empty payload tuple is fine", () => {
    const out = generateTypeDefinitions({ exportedEvents: ["adm_acc"], events: [{ name: "adm_acc", payload: [] }] });
    expect(out).toContain("export interface AdmAccEventPayload {");
  });

  it("every event documented in event_schema.rs generates successfully", () => {
    const events = parseEventCatalog(readFileSync(SCHEMA_RS, "utf8"));
    expect(events.length).toBeGreaterThan(10);
    expect(events.map((e) => e.name)).toEqual(expect.arrayContaining(["sla_calc", "set_int", "cfg_upd", "paused"]));

    const out = generateTypeDefinitions(buildSpec());

    for (const event of events) {
      expect(out).toContain(`/** Payload of the \`${event.name}\` event (tuple order). */`);
    }
    expect(out).toContain('export type ContractEventName = ');
  });

  it("maps the documented payload types", () => {
    const events = parseEventCatalog(readFileSync(SCHEMA_RS, "utf8"));
    const slaCalc = events.find((e) => e.name === "sla_calc")!;

    expect(slaCalc.payload).toEqual([
      { name: "outage_id", tsType: "string" },
      { name: "status", tsType: "string" },
      { name: "payment_type", tsType: "string" },
      { name: "rating", tsType: "string" },
      { name: "mttr_minutes", tsType: "number" },
      { name: "threshold_minutes", tsType: "number" },
      { name: "amount", tsType: "bigint" },
    ]);
  });

  it("a fixture whose catalog has an unmapped payload type names the event and the type", () => {
    const source = ["//! ## odd (`odd`)", "//! - payload: (blob: Bytes)"].join("\n");
    expect(() => parseEventCatalog(source)).toThrow(UnmappedEventTypeError);
    expect(() => parseEventCatalog(source)).toThrow(/odd.*Bytes/);
  });

  it("a catalog entry with no payload line is reported as missing when generating", () => {
    const source = ["//! ## nopayload (`nopayload`)", "//! Emitted somewhere."].join("\n");
    const events = parseEventCatalog(source);

    expect(() => generateTypeDefinitions({ events, exportedEvents: events.map((e) => e.name) })).toThrow(/nopayload/);
  });
});
