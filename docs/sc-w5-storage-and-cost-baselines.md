# SC-W5 Storage and Cost Baselines

This baseline captures the initial contract posture for:
- storage key namespace collision expectations
- pruning-by-age chronology behavior
- storage footprint telemetry signals
- `calculate_sla` critical-path cost regression checkpoints

## Storage Namespace Canonicalization
- Contract storage keys are Symbol constants in `sla_calculator/src/lib.rs`.
- Canonicalization rule: no duplicate semantic domains across keys.
- Regression guard: test additions should fail on newly introduced collisions.

## Pruning-by-Age Chronology
- Pruning behavior must remain deterministic when event chronology is mixed.
- Baseline expectation: older records are removed first regardless of insertion pattern.

## Storage Footprint Telemetry
- Telemetry surface should track:
  - history length before/after prune
  - retained-count target
  - prune operation cadence

## Critical Path Cost Baseline
- `calculate_sla` is treated as critical path.
- Baseline tests should compare behavior across repeated runs and detect major regressions.

## Cold and Warm Storage Baselines (#1024)
- Storage cost reports label the **cold** (first-write) path separately from the
  **warm** (steady-state read/write) paths; the two are never averaged together.
- `StorageCostBaseline` in `sla_calculator/src/benchmarks.rs` carries the three
  values, and `compare_storage_baseline` fails with a message naming the path
  and both the measured and budgeted values when any path exceeds its budget.

## Profile Toolchain Metadata (#1025)
- Every gas profile records the Rust compiler version, the Soroban SDK version
  (`21.0.0`) and the target protocol version (`21`).
- `scripts/profile_wasm_bloat.sh` prints the same metadata at the top of each
  run so reports saved from different sessions can be correlated.
- A profile produced with a different toolchain is marked **incomparable** to
  the stored baseline (`profiles_are_comparable` returns `false`); it must not
  silently replace the baseline.
