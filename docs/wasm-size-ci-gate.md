# WASM Size Gate — Diagnosing a Size Regression

The release WASM must stay within the size budget. This guide covers where the
budget comes from, how to profile a regression, and how to reduce size safely.
Every command below exists in this repository and is run from the repository root.

## Budget source

| Item | Where | Value |
|------|-------|-------|
| Declared budget | `.wasm-budget` (`MAX_WASM_BYTES`) | 65536 bytes |
| Local gate | `scripts/check-wasm-size.ts` (`SIZE_BUDGET_BYTES`) | 100 KB (hard-coded) |
| CI step | `.github/workflows/ci.yml`, "Check contract binary size" | warning above 102400 bytes |

The three values are not currently unified: the local gate and the CI step use
100 KB, while `.wasm-budget` declares 64 KB. Treat the smaller value as the
target when proposing changes, and raise or lower a budget only in a PR with a
written justification (see `CONTRIBUTING.md`).

## Expected release artifact

The artifact is `sla_calculator.wasm`, built with the `wasm32-unknown-unknown`
target in release mode. Because the repository is a Cargo workspace, a plain
build writes it to `target/wasm32-unknown-unknown/release/sla_calculator.wasm`
(this is the path CI measures). `scripts/check-wasm-size.ts` looks for it under
`sla_calculator/target/...`, so for the local gate build into that directory:

```bash
CARGO_TARGET_DIR=sla_calculator/target cargo build --manifest-path sla_calculator/Cargo.toml --target wasm32-unknown-unknown --release
npx ts-node scripts/check-wasm-size.ts
```

If the artifact is missing the script prints the expected path and exits 1.
It prints the size, the budget, and the delta against `sla_calculator/.wasm-size-baseline`
(written on the first run when no baseline exists).

## Profiling a regression

`scripts/profile_wasm_bloat.sh [TOP_N]` runs `cargo-bloat` for the release
wasm32 build and lists the top functions by size (default 20). It installs
`cargo-bloat` if it is missing.

```bash
./scripts/profile_wasm_bloat.sh 30
```

Compare against the baseline branch: run the script on `main` and on your
branch, then look for functions that are new or grew.

## Safe size reductions

- Remove or gate code that is only needed for tests behind `#[cfg(test)]`.
- Avoid pulling in formatting machinery (`format!`, `{:?}` on large types) in
  contract code paths.
- Prefer smaller integer types and `Symbol` over `String` where the schema allows it
  (do not change storage layouts without a migration — see `docs/schema-evolution.md`).
- The repository does not define a `[profile.release]` section today. Size-oriented
  settings (for example `opt-level = "z"`, `lto = true`, `codegen-units = 1`,
  `panic = "abort"`) are a common reduction; measure with the commands above
  before and after and keep contract behaviour and test results unchanged.

After a reduction, re-run the build and `npx ts-node scripts/check-wasm-size.ts`,
and update `sla_calculator/.wasm-size-baseline` only if the new size is intentional.
