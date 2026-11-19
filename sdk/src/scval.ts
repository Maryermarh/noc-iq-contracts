/**
 * Soroban ScVal conversion helpers.
 *
 * Lightweight, dependency-free helpers for converting JS/TS primitive
 * values into a typed, Soroban ScVal-shaped structure and back. A
 * production build would delegate the actual XDR encoding/decoding to
 * `@stellar/stellar-sdk`'s `xdr.ScVal`, but the type tagging and value
 * mapping here mirror that conversion so the client's typed methods have
 * a single place to route argument/result conversion through.
 */

export type ScValType =
  | "void"
  | "bool"
  | "u32"
  | "i32"
  | "u128"
  | "i128"
  | "string"
  | "symbol"
  | "address"
  | "vec"
  | "map";

export interface ScVal {
  type: ScValType;
  value: unknown;
}

/** Inclusive bounds of the integer types the encoder can represent. */
const U32_MAX = 4_294_967_295;
const I32_MIN = -2_147_483_648;
const U128_MAX = (1n << 128n) - 1n;
const I128_MIN = -(1n << 127n);

/** Thrown when an integer cannot be represented by the supported XDR integer types (issue #1074). */
export class ScValRangeError extends RangeError {
  constructor(
    readonly field: string,
    readonly value: number | bigint,
    readonly range: string,
  ) {
    super(`${field}: ${value} is outside the supported range ${range}`);
    this.name = "ScValRangeError";
  }
}

/** Stellar strkey account (G...) or contract (C...) address pattern. */
const ADDRESS_PATTERN = /^[GC][A-Z2-7]{55}$/;

/**
 * Converts a JS/TS primitive value into a typed ScVal-shaped structure.
 *
 * Numbers are mapped to u32/i32, bigints to u128/i128 (by sign), strings
 * that look like a Stellar address to the `address` type, arrays to `vec`,
 * and plain objects to `map`.
 */
export function toScVal(value: unknown, field: string | number = "value"): ScVal {
  // `args.map(toScVal)` passes the argument position as the second parameter; name it.
  const name = typeof field === "number" ? `arg[${field}]` : field;
  if (value === null || value === undefined) {
    return { type: "void", value: null };
  }
  if (typeof value === "boolean") {
    return { type: "bool", value };
  }
  if (typeof value === "bigint") {
    if (value < I128_MIN || value > U128_MAX) {
      throw new ScValRangeError(name, value, `[${I128_MIN}, ${U128_MAX}]`);
    }
    return { type: value < 0n ? "i128" : "u128", value };
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError(
        `${name}: cannot convert non-integer number ${value} to ScVal — use a bigint for fractional/large values`,
      );
    }
    // Checked before anything is built, so an out-of-range value can never become truncated XDR.
    if (value < I32_MIN || value > U32_MAX) {
      throw new ScValRangeError(name, value, `[${I32_MIN}, ${U32_MAX}] (use a bigint for larger values)`);
    }
    return { type: value < 0 ? "i32" : "u32", value };
  }
  if (typeof value === "string") {
    return { type: ADDRESS_PATTERN.test(value) ? "address" : "string", value };
  }
  if (Array.isArray(value)) {
    return { type: "vec", value: value.map((item, index) => toScVal(item, `${name}[${index}]`)) };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, val]) => [key, toScVal(val, `${name}.${key}`)] as const,
    );
    return { type: "map", value: entries };
  }
  throw new TypeError(`Cannot convert value of type ${typeof value} to ScVal`);
}

/**
 * Converts an ScVal-shaped structure back into a plain JS/TS value,
 * recursively unwrapping `vec` and `map` entries.
 */
export function fromScVal(scVal: ScVal): unknown {
  switch (scVal.type) {
    case "void":
      return null;
    case "vec":
      return (scVal.value as ScVal[]).map(fromScVal);
    case "map":
      return Object.fromEntries(
        (scVal.value as Array<readonly [string, ScVal]>).map(([key, val]) => [
          key,
          fromScVal(val),
        ]),
      );
    default:
      return scVal.value;
  }
}
