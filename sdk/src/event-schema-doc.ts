/**
 * Parses the canonical event catalog documented in `sla_calculator/src/event_schema.rs` into
 * TypeScript event descriptions (issue #1073), so the SDK's generated types are derived from the
 * same text that defines the on-chain event schema instead of a hand-maintained copy.
 */

import { TypeGenEvent, TypeGenField } from "./typegen";

/** Rust payload types that have a direct TypeScript representation. */
const RUST_TO_TS: Record<string, string> = {
  u32: "number",
  i32: "number",
  u64: "bigint",
  i64: "bigint",
  u128: "bigint",
  i128: "bigint",
  bool: "boolean",
  Symbol: "string",
  String: "string",
  Address: "string",
};

export class UnmappedEventTypeError extends Error {
  constructor(
    readonly event: string,
    readonly rustType: string,
  ) {
    super(`Event "${event}": payload type "${rustType}" has no TypeScript mapping`);
    this.name = "UnmappedEventTypeError";
  }
}

function mapRustType(event: string, rustType: string): string {
  const trimmed = rustType.trim();
  const direct = RUST_TO_TS[trimmed];
  if (direct) return direct;
  const vec = /^Vec<(.+)>$/.exec(trimmed);
  if (vec) return `${mapRustType(event, vec[1])}[]`;
  const option = /^Option<(.+)>$/.exec(trimmed);
  if (option) return `${mapRustType(event, option[1])} | null`;
  throw new UnmappedEventTypeError(event, trimmed);
}

/** Splits a tuple body on top-level commas (ignores commas inside `<...>`). */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "<") depth += 1;
    if (ch === ">") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/**
 * Extracts every `## <name> (`<symbol>`)` entry of the catalog together with its payload tuple.
 * Payloads such as `()` yield no fields; `(true,)` / `(false,)` (a bare literal) become a single
 * boolean field named after the event.
 */
export function parseEventCatalog(source: string): TypeGenEvent[] {
  const doc = source
    .split("\n")
    .filter((line) => line.startsWith("//!"))
    .map((line) => line.replace(/^\/\/! ?/, ""));

  const events: TypeGenEvent[] = [];
  for (let i = 0; i < doc.length; i++) {
    const heading = /^## (\S+) \(`([^`]+)`\)/.exec(doc[i]);
    if (!heading) continue;
    const name = heading[2];

    // The payload is on a "- payload:" line and may wrap onto indented continuation lines.
    let payloadText: string | undefined;
    for (let j = i + 1; j < doc.length && !doc[j].startsWith("## "); j++) {
      const m = /^- payload:\s*(.*)$/.exec(doc[j]);
      if (!m) continue;
      payloadText = m[1];
      while (!payloadText.includes(")") && j + 1 < doc.length && /^\s+\S/.test(doc[j + 1])) {
        j += 1;
        payloadText += " " + doc[j].trim();
      }
      break;
    }

    if (payloadText === undefined) {
      events.push({ name }); // documented but no payload description: reported as missing later
      continue;
    }
    const open = payloadText.indexOf("(");
    const close = payloadText.lastIndexOf(")");
    const body = open >= 0 && close > open ? payloadText.slice(open + 1, close) : "";

    const payload: TypeGenField[] = splitTopLevel(body).map((part) => {
      if (part === "true" || part === "false") return { name: "value", tsType: "boolean" };
      const colon = part.indexOf(":");
      if (colon === -1) throw new UnmappedEventTypeError(name, part);
      return { name: part.slice(0, colon).trim(), tsType: mapRustType(name, part.slice(colon + 1)) };
    });
    events.push({ name, payload });
  }
  return events;
}
