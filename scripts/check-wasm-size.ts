/**
 * SC-042: Enforce contract WASM size budget.
 * Fails CI if the built WASM exceeds the threshold; prints delta vs baseline.
 */

import * as fs from "fs";
import * as path from "path";

const WASM_PATH = path.resolve(
  "sla_calculator/target/wasm32-unknown-unknown/release/sla_calculator.wasm"
);

// Fallback budget in bytes, used only when .wasm-budget is absent.
const DEFAULT_BUDGET_BYTES = 100 * 1024; // 100 KB
const BUDGET_FILE = path.resolve(".wasm-budget");
export const BUILD_COMMAND =
  "cargo build --target wasm32-unknown-unknown --release -p sla_calculator";

/** Reads MAX_WASM_BYTES from a `.wasm-budget` file; falls back to the default. */
export function readBudget(file: string = BUDGET_FILE): number {
  try {
    const m = /^\s*MAX_WASM_BYTES\s*=\s*(\d+)\s*$/m.exec(fs.readFileSync(file, "utf8"));
    if (m) return parseInt(m[1], 10);
  } catch {
    /* fall through */
  }
  return DEFAULT_BUDGET_BYTES;
}

export interface SizeVerdict {
  ok: boolean;
  message: string;
}

/**
 * Pure size gate: an artifact exactly at the budget passes, one byte over
 * fails, and a missing artifact (size === null) always fails with the
 * expected path and the command that produces it.
 */
export function evaluateSize(
  size: number | null,
  budget: number,
  wasmPath: string = WASM_PATH,
): SizeVerdict {
  if (size === null) {
    return {
      ok: false,
      message: `WASM artifact missing at ${wasmPath}. Build it first with: ${BUILD_COMMAND}`,
    };
  }
  if (size > budget) {
    return { ok: false, message: `WASM size ${size} B exceeds budget ${budget} B (over by ${size - budget} B)` };
  }
  return { ok: true, message: `WASM size ${size} B within budget ${budget} B` };
}

// Baseline snapshot file — updated by maintainers on intentional size changes.
const BASELINE_FILE = path.resolve("sla_calculator/.wasm-size-baseline");

function readBaseline(): number | null {
  try {
    return parseInt(fs.readFileSync(BASELINE_FILE, "utf8").trim(), 10);
  } catch {
    return null;
  }
}

function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KB`;
}

function checkSize(): void {
  if (!fs.existsSync(WASM_PATH)) {
    console.error(`❌ ${evaluateSize(null, 0).message}`);
    process.exit(1);
  }

  const { size } = fs.statSync(WASM_PATH);
  const SIZE_BUDGET_BYTES = readBudget();
  const baseline = readBaseline();

  console.log(`WASM size : ${formatKB(size)}`);
  console.log(`Budget    : ${formatKB(SIZE_BUDGET_BYTES)}`);

  if (baseline !== null) {
    const delta = size - baseline;
    const sign = delta >= 0 ? "+" : "";
    console.log(`Delta vs baseline: ${sign}${formatKB(delta)}`);
    if (delta > 0) console.warn("⚠️  Size increased since last baseline — update baseline if intentional.");
  } else {
    console.log("No baseline found — writing current size as baseline.");
    fs.writeFileSync(BASELINE_FILE, String(size));
  }

  if (size > SIZE_BUDGET_BYTES) {
    console.error(`❌ WASM size ${formatKB(size)} exceeds budget ${formatKB(SIZE_BUDGET_BYTES)}`);
    console.error("To raise the budget, update SIZE_BUDGET_BYTES in scripts/check-wasm-size.ts with a PR justification.");
    process.exit(1);
  }

  console.log("✅ WASM size within budget.");
}

if (require.main === module) {
  checkSize();
}
