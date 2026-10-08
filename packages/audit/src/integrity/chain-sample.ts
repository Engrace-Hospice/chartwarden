// @wardenx/audit — sampled verification of the audit hash chain (M4 §4.4 `audit.integrity_sample`,
// §10.4, §12.3). Pure logic — `node:crypto` only, no DB; the Drizzle reader lives in ./db-chain-reader.
//
// WHAT IS THE REFERENCE. The spec's quarterly sample compares live rows with a pgBackRest backup. This
// repo has no backup reader, so the only INDEPENDENT reference for a closed month is the `audit_seal` row
// written when the month closed: a sha-256 chain over the month's ordered per-row hashes, linked to the
// previous month's seal (`prev_chain_hash`). A later UPDATE/DELETE/INSERT of any row of a sealed month
// changes the recomputed chain hash; a removed or reordered seal breaks the `prev_chain_hash` link.
//
// A flat chain hash cannot be checked from a handful of rows, so the "sample" is a sample of SEALS: the
// chain linkage is checked end to end (it is cheap — seals only) and a bounded random subset of sealed
// months (always including the newest) is fully recomputed from the live rows.
import { createHash } from "node:crypto";

/** Bumped if the per-row canonical form ever changes (a new version seals new months only). */
export const AUDIT_ROW_HASH_VERSION = "v1";

/** The columns of one `audit_event` row that the seal covers. jsonb columns arrive as exact `::text`. */
export interface AuditRowForHash {
  readonly id: string;
  /** `created_at` as UTC ISO-8601 WITH MICROSECONDS (a JS Date would drop them). */
  readonly createdAt: string;
  readonly organizationId: string | null;
  readonly actorUserId: string | null;
  readonly actorKind: string;
  readonly actorRole: string | null;
  readonly eventType: string;
  readonly resourceKind: string;
  readonly resourceId: string | null;
  readonly correlationId: string;
  readonly outcome: string;
  readonly severity: string;
  readonly retentionClass: string;
  readonly beforeText: string | null;
  readonly afterText: string | null;
  readonly contextText: string | null;
}

/** sha-256 over a versioned, field-ordered canonical form of EVERY tamper-relevant column of the row. */
export function hashAuditRow(row: AuditRowForHash): string {
  const canonical = JSON.stringify([
    AUDIT_ROW_HASH_VERSION,
    row.id,
    row.createdAt,
    row.organizationId,
    row.actorUserId,
    row.actorKind,
    row.actorRole,
    row.eventType,
    row.resourceKind,
    row.resourceId,
    row.correlationId,
    row.outcome,
    row.severity,
    row.retentionClass,
    row.beforeText,
    row.afterText,
    row.contextText,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Streaming twin of `computeChainHash` (./index): feeding the same ordered hashes yields the same digest,
 * but a month with millions of rows never has to be held in memory.
 */
export function createChainHasher(prevChainHash: string | null): {
  add(eventHash: string): void;
  digest(): string;
} {
  const h = createHash("sha256");
  h.update(prevChainHash ?? "GENESIS");
  return {
    add(eventHash) {
      h.update("|");
      h.update(eventHash);
    },
    digest: () => h.digest("hex"),
  };
}

/** The `audit_seal` columns the verifier reasons about. */
export interface StoredSeal {
  readonly partition: string;
  readonly prevChainHash: string | null;
  readonly chainHash: string;
  readonly eventCount: number;
  readonly fromId: string;
  readonly toId: string;
}

/** `audit_event_2026_09` ⇄ `2026-09`. */
export const partitionNameForMonth = (month: string): string =>
  `audit_event_${month.replace("-", "_")}`;
export const monthForPartitionName = (partition: string): string =>
  partition.replace(/^audit_event_/, "").replace("_", "-");

export type ChainBreakReason =
  | "prev_link_mismatch"
  | "chain_hash_mismatch"
  | "event_count_mismatch"
  | "first_last_mismatch"
  | "unsealed_closed_month"
  | "partition_unreadable";

export interface ChainBreak {
  readonly partition: string;
  readonly reason: ChainBreakReason;
}

/**
 * Check the `prev_chain_hash` links of an ordered seal list: the first seal is genesis, every later seal
 * must point at its predecessor's `chain_hash`. A deleted, reordered or substituted seal breaks a link.
 */
export function verifySealLinkage(seals: readonly StoredSeal[]): ChainBreak[] {
  const breaks: ChainBreak[] = [];
  let prev: string | null = null;
  for (const seal of seals) {
    if (seal.prevChainHash !== prev) {
      breaks.push({ partition: seal.partition, reason: "prev_link_mismatch" });
    }
    prev = seal.chainHash;
  }
  return breaks;
}

/**
 * Which seals to recompute: the newest one always (the closest to the live write path) plus up to
 * `size - 1` more drawn without replacement. `random` is injectable so a test pins the draw.
 */
export function selectSealSample<T>(
  seals: readonly T[],
  size: number,
  random: () => number = Math.random,
): T[] {
  if (seals.length === 0 || size <= 0) return [];
  if (size >= seals.length) return [...seals];
  const newest = seals[seals.length - 1] as T;
  const pool = seals.slice(0, -1);
  const picked: T[] = [];
  while (picked.length < size - 1 && pool.length > 0) {
    const i = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    picked.push(pool.splice(i, 1)[0] as T);
  }
  return [...picked, newest];
}

/** What a recomputation of one sealed month produced. */
export interface RecomputedMonth {
  readonly eventCount: number;
  readonly fromId: string | null;
  readonly toId: string | null;
  readonly chainHash: string;
}

/** Compare a stored seal with the digest recomputed from the live rows; the first divergence wins. */
export function compareSealToRecomputed(
  seal: StoredSeal,
  recomputed: RecomputedMonth,
): ChainBreakReason | null {
  if (recomputed.eventCount !== seal.eventCount) return "event_count_mismatch";
  if (recomputed.fromId !== seal.fromId || recomputed.toId !== seal.toId) {
    return "first_last_mismatch";
  }
  if (recomputed.chainHash !== seal.chainHash) return "chain_hash_mismatch";
  return null;
}
