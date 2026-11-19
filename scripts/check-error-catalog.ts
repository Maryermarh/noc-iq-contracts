/**
 * #1055: fails when the contract's `SLAError` enum and the off-chain error catalog diverge.
 *
 * Usage (from the repo root or `sdk/`):
 *   npx ts-node --transpile-only scripts/check-error-catalog.ts
 */
import * as fs from "fs";
import * as path from "path";
import { compareCatalogToContract } from "../offchain/deterministicErrorCatalog";

const LIB_RS = path.resolve(__dirname, "../sla_calculator/src/lib.rs");

const drift = compareCatalogToContract(fs.readFileSync(LIB_RS, "utf8"));

if (drift.missingFromCatalog.length === 0 && drift.staleInCatalog.length === 0) {
  console.log("Error catalog covers every contract error code.");
} else {
  for (const v of drift.missingFromCatalog) {
    console.error(`::error::SLAError::${v.name} (#${v.code}) has no entry in offchain/deterministicErrorCatalog.ts`);
  }
  for (const code of drift.staleInCatalog) {
    console.error(`::error::Catalog entry ${code} does not match any SLAError variant`);
  }
  process.exit(1);
}
