/**
 * SC-W5-112: Duplicate transaction hash correlation strategy for retries.
 *
 * When the backend retries a submission, Stellar may return a duplicate hash
 * (same envelope resubmitted) or a new hash (rebuilt tx). This module tracks
 * correlation between original and retry submissions to prevent double-application
 * of contract calls (e.g. calculate_sla called twice for the same outage_id).
 */

/** Networks a transaction hash can belong to. The same hash on two networks is two transactions. */
export type StellarNetwork = "mainnet" | "testnet" | "futurenet";

const NETWORKS: readonly StellarNetwork[] = ["mainnet", "testnet", "futurenet"];

/** A Stellar transaction hash is exactly 32 bytes, written as 64 hexadecimal characters. */
const TX_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Normalizes the only documented hash form: 64 hex digits, any case, to lower case.
 * Anything else (truncated, over-long, prefixed, padded or non-hex input) is rejected rather
 * than coerced, so two different transactions can never collapse onto one key.
 */
export function normalizeTxHash(hash: string): string {
  if (typeof hash !== "string" || !TX_HASH_PATTERN.test(hash)) {
    throw new Error(`[SC-W5-112] Malformed tx hash: expected 64 hex characters, got ${JSON.stringify(hash)}`);
  }
  return hash.toLowerCase();
}

function assertNetwork(network: string): asserts network is StellarNetwork {
  if (!NETWORKS.includes(network as StellarNetwork)) {
    throw new Error(`[SC-W5-112] Unknown network ${JSON.stringify(network)}`);
  }
}

/** Correlation key: the full normalized hash together with its network. */
export function correlationKey(network: StellarNetwork, hash: string): string {
  assertNetwork(network);
  return `${network}:${normalizeTxHash(hash)}`;
}

export interface TxRecord {
  outage_id: string;
  network: StellarNetwork;
  tx_hash: string;
  submitted_at: number; // unix ms
  confirmed: boolean;
}

/** In-memory correlation registry (backend would back this with persistent storage). */
export class TxHashCorrelationRegistry {
  private records = new Map<string, TxRecord>(); // key: outage_id
  private byKey = new Map<string, string>(); // correlation key -> outage_id

  /**
   * Attempts to register a submission. The hash is validated and normalized first.
   * Returns false (duplicate detected) if the outage_id already has a confirmed tx.
   */
  register(record: TxRecord): { accepted: boolean; reason: string } {
    const key = correlationKey(record.network, record.tx_hash);
    const existing = this.records.get(record.outage_id);
    if (existing?.confirmed) {
      return { accepted: false, reason: `outage_id ${record.outage_id} already confirmed via ${existing.tx_hash}` };
    }
    const owner = this.byKey.get(key);
    if (owner !== undefined && owner !== record.outage_id) {
      return { accepted: false, reason: `tx ${key} is already correlated to outage_id ${owner}` };
    }
    this.records.set(record.outage_id, { ...record, tx_hash: normalizeTxHash(record.tx_hash) });
    this.byKey.set(key, record.outage_id);
    return { accepted: true, reason: "registered" };
  }

  confirm(outage_id: string, network: StellarNetwork, tx_hash: string): void {
    const r = this.records.get(outage_id);
    if (!r) throw new Error(`[SC-W5-112] No record for outage_id ${outage_id}`);
    const expected = correlationKey(r.network, r.tx_hash);
    const actual = correlationKey(network, tx_hash);
    if (expected !== actual) throw new Error(`[SC-W5-112] Hash mismatch: expected ${expected}, got ${actual}`);
    r.confirmed = true;
  }

  isConfirmed(outage_id: string): boolean {
    return this.records.get(outage_id)?.confirmed ?? false;
  }

  /** Outage correlated to a (network, hash) pair, or undefined. Malformed hashes throw. */
  outageFor(network: StellarNetwork, tx_hash: string): string | undefined {
    return this.byKey.get(correlationKey(network, tx_hash));
  }
}

const H = (c: string) => c.repeat(64); // 64-char hash made of one hex digit

function expectThrows(fn: () => unknown, label: string): void {
  try {
    fn();
  } catch (e: any) {
    if (!String(e.message).includes("SC-W5-112")) throw e;
    console.log(`  ✓ ${label}`);
    return;
  }
  throw new Error(`Expected a throw: ${label}`);
}

function runTests(): void {
  console.log("[SC-W5-112] Duplicate tx hash correlation tests\n");
  const reg = new TxHashCorrelationRegistry();

  // Normal registration
  const r1 = reg.register({ outage_id: "OUT001", network: "testnet", tx_hash: H("a"), submitted_at: 1000, confirmed: false });
  if (!r1.accepted) throw new Error("Expected accepted");
  console.log("  ✓ first submission accepted");

  // Retry before confirmation — allowed (tx may not have landed)
  const r2 = reg.register({ outage_id: "OUT001", network: "testnet", tx_hash: H("b"), submitted_at: 2000, confirmed: false });
  if (!r2.accepted) throw new Error("Expected retry accepted before confirmation");
  console.log("  ✓ retry before confirmation accepted");

  // Confirm (upper-case variant normalizes to the registered lower-case hash)
  reg.confirm("OUT001", "testnet", H("B"));
  if (!reg.isConfirmed("OUT001")) throw new Error("Expected confirmed");
  console.log("  ✓ confirmation recorded; case variants normalize deterministically");

  // Retry after confirmation — must be rejected
  const r3 = reg.register({ outage_id: "OUT001", network: "testnet", tx_hash: H("c"), submitted_at: 3000, confirmed: false });
  if (r3.accepted) throw new Error("Should reject post-confirmation duplicate");
  console.log("  ✓ post-confirmation duplicate rejected");

  // Hash mismatch on confirm
  const reg2 = new TxHashCorrelationRegistry();
  reg2.register({ outage_id: "OUT002", network: "testnet", tx_hash: H("1"), submitted_at: 1000, confirmed: false });
  expectThrows(() => reg2.confirm("OUT002", "testnet", H("2")), "adversarial: hash mismatch on confirm rejected");

  // The same hash on another network is a different transaction.
  expectThrows(() => reg2.confirm("OUT002", "mainnet", H("1")), "adversarial: same hash on another network is not a match");
  if (correlationKey("testnet", H("1")) === correlationKey("mainnet", H("1"))) throw new Error("Keys must include the network");
  console.log("  ✓ network is part of the correlation key");

  // Malformed and truncated hashes are rejected, not prefix-matched.
  for (const bad of ["HASH1", H("a").slice(0, 63), H("a") + "a", "0x" + H("a").slice(2), H("g"), " " + H("a"), ""]) {
    expectThrows(() => normalizeTxHash(bad), `adversarial: malformed hash ${JSON.stringify(bad.slice(0, 12))} rejected`);
  }

  // Two outages cannot share one (network, hash).
  const reg3 = new TxHashCorrelationRegistry();
  reg3.register({ outage_id: "OUT003", network: "testnet", tx_hash: H("d"), submitted_at: 1, confirmed: false });
  const clash = reg3.register({ outage_id: "OUT004", network: "testnet", tx_hash: H("D"), submitted_at: 2, confirmed: false });
  if (clash.accepted) throw new Error("Same network+hash must not correlate to two outages");
  const otherNet = reg3.register({ outage_id: "OUT004", network: "mainnet", tx_hash: H("d"), submitted_at: 2, confirmed: false });
  if (!otherNet.accepted) throw new Error("Same hash on another network must be a distinct key");
  console.log("  ✓ one outage per (network, hash); other networks are independent");

  expectThrows(() => correlationKey("devnet" as StellarNetwork, H("a")), "adversarial: unknown network rejected");

  console.log("\nAll duplicate tx hash correlation tests passed.");
}

runTests();
