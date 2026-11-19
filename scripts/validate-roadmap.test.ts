import { describe, it, expect } from "vitest";
import { findStaleLinks } from "./validate-roadmap";

const tree = new Set(["scripts/check-wasm-size.ts", "sla_calculator/src/lib.rs"]);
const exists = (p: string) => tree.has(p);

describe("findStaleLinks", () => {
  it("reports the source document, line and link for a stale path", () => {
    const text = "ok `scripts/check-wasm-size.ts`\nsee [old](scripts/removed-tool.ts)\n";
    expect(findStaleLinks("TODO.md", text, exists)).toEqual([
      { doc: "TODO.md", line: 2, link: "scripts/removed-tool.ts" },
    ]);
  });

  it("accepts references that resolve", () => {
    expect(
      findStaleLinks("TODO.md", "`sla_calculator/src/lib.rs` and [x](sla_calculator/src/lib.rs#L3)", exists),
    ).toEqual([]);
  });

  it("ignores URLs, anchors and globs", () => {
    const text = "[a](https://example.com/x.md) [b](#top) `tests/*.test.ts`";
    expect(findStaleLinks("TODO.md", text, exists)).toEqual([]);
  });
});
