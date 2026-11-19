# Schema Evolution Playbook

This document describes how to safely evolve the SLA Calculator contract's storage schema and ABI.

## Version Bump Checklist

1. Increment `STORAGE_VERSION` in `lib.rs`
2. Add migration step in `migrate()` function
3. Run the executable migration checks: `cargo test -- migration`
4. Update `CHANGELOG.md` with breaking changes
5. Verify `get_migration_state()` reports correct versions

## Executable Migration Checks

```bash
# Verify migration from any previous version
cargo test --test integration -- migration_upgrade_path

# Verify downgrade safety
cargo test --test integration -- migration_downgrade_guard

# Verify idempotency
cargo test --test integration -- migration_idempotent
```

## Migration Dry Run

`scripts/migration-dry-run.ts` validates, before anything is planned or applied,
that the target schema version is reachable from the deployed version through
the upgrade steps listed in `SUPPORTED_UPGRADES` (keep it in sync with
`sla_calculator/src/storage_migration.rs`). Downgrades, versions newer than
`CURRENT_STORAGE_VERSION`, and jumps with no supported path fail first. The
report lists the exact source version, target version and upgrade path.

## Backward Compatibility Rules

- Additive field additions to existing structs are backward compatible
- Field removal or type changes require a version bump
- New error variants must be appended to the end of the enum
- Event schema changes must emit a new event version symbol
