/**
 * CLI: regenerates TypeScript definitions from the contract spec.
 *
 * Usage: npm run generate:types [outputPath]
 *
 * Reads the contract spec (currently a placeholder — production use would
 * source this from `SLACalculatorClient.loadContractSpec()` or by parsing
 * the compiled WASM's spec section directly) and writes formatted `.d.ts`
 * declarations to `outputPath` (default: sdk/src/generated-types.d.ts).
 *
 * Writes to a separate generated file rather than overwriting the
 * hand-maintained sdk/src/types.ts, so curated types/docs aren't clobbered
 * by a codegen run.
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { generateTypeDefinitions, TypeGenSpec } from "../src/typegen";
import { parseEventCatalog } from "../src/event-schema-doc";

/** The canonical on-chain event catalog; every documented event must have a TypeScript schema. */
const EVENT_SCHEMA_PATH = join(__dirname, "..", "..", "sla_calculator", "src", "event_schema.rs");

export function loadPlaceholderSpec(): TypeGenSpec {
  // Placeholder spec matching the SLA calculator's core functions. A full
  // implementation would parse this from the compiled WASM spec section
  // instead of being hand-written here.
  return {
    structs: [
      {
        name: "GeneratedSLAConfig",
        fields: [
          { name: "threshold_minutes", tsType: "number" },
          { name: "penalty_per_minute", tsType: "bigint" },
          { name: "reward_base", tsType: "bigint" },
        ],
      },
    ],
    functions: [
      {
        name: "get_config",
        params: [{ name: "severity", tsType: "string" }],
        returns: "GeneratedSLAConfig",
      },
      {
        name: "calculate_sla",
        params: [
          { name: "caller", tsType: "string" },
          { name: "outage_id", tsType: "string" },
          { name: "severity", tsType: "string" },
          { name: "mttr_minutes", tsType: "number" },
        ],
        returns: "unknown",
      },
    ],
  };
}

/**
 * The full spec: the placeholder structs/functions plus the events documented in
 * `event_schema.rs`. Every documented event is also listed as exported, so an event without a
 * parsable payload fails generation by name (issue #1073).
 */
export function buildSpec(eventSchemaSource: string = readFileSync(EVENT_SCHEMA_PATH, "utf8")): TypeGenSpec {
  const events = parseEventCatalog(eventSchemaSource);
  return {
    ...loadPlaceholderSpec(),
    events,
    exportedEvents: events.map((e) => e.name),
  };
}

function main(): void {
  const outputPath = process.argv[2] ?? "src/generated-types.d.ts";
  const output = generateTypeDefinitions(buildSpec());
  writeFileSync(outputPath, output);
  console.log(`Wrote generated types to ${outputPath}`);
}

if (require.main === module) {
  main();
}
