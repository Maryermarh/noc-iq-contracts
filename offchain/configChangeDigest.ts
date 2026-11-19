export interface ConfigChange {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  changedAt: number;
  changedBy: string;
}

export interface DigestedChange {
  change: ConfigChange;
  digest: string;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys); // list order is meaningful: kept as is
  if (value !== null && typeof value === "object") {
    const withToJson = value as { toJSON?: () => unknown };
    if (typeof withToJson.toJSON === "function") return sortKeys(withToJson.toJSON());
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
    return out;
  }
  return value;
}

/**
 * JSON with every object's keys sorted, at any depth. Two values that differ only in key order
 * serialize identically; arrays keep their order because list position carries meaning (for
 * example a severity ladder), so reordering an array changes the result.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function digestChange(c: ConfigChange): string {
  return simpleHash(canonicalJson([c.key, c.oldValue, c.newValue, c.changedAt, c.changedBy]));
}

export function wrapWithDigest(change: ConfigChange): DigestedChange {
  return { change, digest: digestChange(change) };
}

export function verifyDigest(d: DigestedChange): boolean {
  return digestChange(d.change) === d.digest;
}
