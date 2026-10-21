// @chartwarden/audit — Integrity & tamper-evidence layer (M4-T11, M4 spec §3.5, §10.4, §12.3).
//
// Three controls that prove the append-only `audit_event` log was not altered after the fact:
//
//   1. APPEND-ONLY VERIFICATION (§10.4, §12.3). The audit log's immutability rests on a GRANT
//      model — the app role may INSERT (via the `chartwarden_audit_writer` SECURITY DEFINER) and
//      SELECT, never UPDATE/DELETE/TRUNCATE. `verifyAppendOnly()` is the assertion that holds:
//      given a snapshot of the privileges actually granted, it returns every violation (a
//      mutating privilege present on `audit_event` for an app role). Empty = the model holds.
//   2. SAMPLE-VS-BACKUP (§4.4 `audit.integrity_sample`, §12.3). Quarterly, a sample of live event
//      hashes is compared against the pgBackRest backup's hashes; any divergence (altered,
//      missing-in-backup, missing-in-live) is a mismatch the job alerts on (Security Hardening T6).
//   3. HASH-CHAIN SEAL (§3.5 `audit_seal`, PHASE 2 — flag `audit_hash_chain_enabled`). On a closed
//      partition, a checkpoint links to the prior seal via `prev_chain_hash`, forming a chain over
//      the ordered per-event hashes so any post-hoc modification breaks the chain. The crypto here
//      is always available + unit-tested; the seal *job* stays inert until the flag is on (§14 D2).
//
// Pure logic — `node:crypto` only, no DB. The Drizzle adapters (read GRANTs from pg_catalog, the
// partition event reader, the `audit_seal` writer) are tracked follow-ups, like the rest of M4.
import { createHash } from "node:crypto";

// --- 1. Append-only GRANT verification (§10.4, §12.3) ------------------------------------------

/** The mutating privileges that must NEVER be granted to an app role on the audit log (§10.4). */
export const MUTATING_PRIVILEGES = ["UPDATE", "DELETE", "TRUNCATE"] as const;

/** The roles treated as "the application" — none may mutate `audit_event` (§9.3 cross-ref). */
export const APP_ROLES = ["chartwarden_app"] as const;

/** A snapshot of the privileges actually granted to one role on one table (from `pg_catalog`). */
export interface GrantSnapshot {
  readonly role: string;
  readonly table: string;
  /** Privilege names as Postgres reports them, e.g. `SELECT`, `INSERT`, `UPDATE`. */
  readonly privileges: readonly string[];
}

/** A detected breach of the append-only model: a mutating privilege present for an app role. */
export interface AppendOnlyViolation {
  readonly role: string;
  readonly table: string;
  /** The disallowed privileges that were present (subset of `MUTATING_PRIVILEGES`). */
  readonly forbidden: string[];
}

/**
 * Verify the append-only GRANT model holds: no app role carries UPDATE/DELETE/TRUNCATE on the
 * audit log. Returns every violation (empty array = the model is intact). Pure over the injected
 * snapshot so the immutability assertion can run in a unit test and against a live `pg_catalog`
 * read identically.
 */
export function verifyAppendOnly(
  grants: readonly GrantSnapshot[],
  opts: { readonly appRoles?: readonly string[]; readonly auditTables?: readonly string[] } = {},
): AppendOnlyViolation[] {
  const appRoles = new Set((opts.appRoles ?? APP_ROLES).map((r) => r.toLowerCase()));
  const auditTables = opts.auditTables
    ? new Set(opts.auditTables.map((t) => t.toLowerCase()))
    : null; // null = check every table in the snapshot
  const violations: AppendOnlyViolation[] = [];
  for (const grant of grants) {
    if (!appRoles.has(grant.role.toLowerCase())) continue;
    if (auditTables && !auditTables.has(grant.table.toLowerCase())) continue;
    const present = grant.privileges.map((p) => p.toUpperCase());
    const forbidden = MUTATING_PRIVILEGES.filter((p) => present.includes(p));
    if (forbidden.length > 0) {
      violations.push({ role: grant.role, table: grant.table, forbidden });
    }
  }
  return violations;
}

// --- 2. Sample-vs-backup integrity check (§4.4, §12.3) ----------------------------------------

/** One sampled event reduced to its identity + content hash (PHI never leaves the DB here). */
export interface IntegritySampleRow {
  readonly id: string;
  /** A content hash of the row (see `hashEvent`); compared live↔backup. */
  readonly hash: string;
}

/** A divergence between the live log and its backup for one event id. */
export interface SampleMismatch {
  readonly id: string;
  readonly kind: "altered" | "missing_in_backup" | "missing_in_live";
  readonly liveHash: string | null;
  readonly backupHash: string | null;
}

/**
 * Compare a sample of live event hashes against the same ids in a backup. Any id whose hashes
 * differ is `altered`; an id present on only one side is `missing_in_*`. A non-empty result is the
 * negative signal the `audit.integrity_sample` job alerts on (§12.3 — detects an altered backup row).
 */
export function compareSampleToBackup(
  live: readonly IntegritySampleRow[],
  backup: readonly IntegritySampleRow[],
): SampleMismatch[] {
  const liveById = new Map(live.map((r) => [r.id, r.hash]));
  const backupById = new Map(backup.map((r) => [r.id, r.hash]));
  const mismatches: SampleMismatch[] = [];
  for (const [id, liveHash] of liveById) {
    const backupHash = backupById.get(id);
    if (backupHash === undefined) {
      mismatches.push({ id, kind: "missing_in_backup", liveHash, backupHash: null });
    } else if (backupHash !== liveHash) {
      mismatches.push({ id, kind: "altered", liveHash, backupHash });
    }
  }
  for (const [id, backupHash] of backupById) {
    if (!liveById.has(id)) {
      mismatches.push({ id, kind: "missing_in_live", liveHash: null, backupHash });
    }
  }
  return mismatches;
}

// --- 3. Hash-chain seal (§3.5 audit_seal, PHASE 2 — flag-gated) --------------------------------

/** The Phase-2 feature flag the seal job is gated behind (`audit_seal` rows only created when on). */
export const AUDIT_HASH_CHAIN_FLAG = "audit_hash_chain_enabled";

/** A content hash over the immutable fields of one event — the unit the chain is computed over. */
export function hashEvent(event: {
  readonly id: string;
  readonly createdAt: string;
  readonly eventType: string;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly context?: unknown;
}): string {
  // Canonical, field-ordered serialization so the hash is stable across object key order.
  const canonical = JSON.stringify([
    event.id,
    event.createdAt,
    event.eventType,
    event.before ?? null,
    event.after ?? null,
    event.context ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Compute the chain hash for a partition: sha-256 over the prior link + the ordered event hashes. */
export function computeChainHash(
  prevChainHash: string | null,
  eventHashes: readonly string[],
): string {
  const h = createHash("sha256");
  h.update(prevChainHash ?? "GENESIS");
  for (const eh of eventHashes) {
    h.update("|");
    h.update(eh);
  }
  return h.digest("hex");
}

/** The inputs to seal one closed partition (ordered events + the prior seal's chain hash). */
export interface SealInput {
  readonly partition: string;
  readonly organizationId: string | null;
  /** The partition's events in canonical (createdAt, id) order, each already hashed. */
  readonly events: readonly IntegritySampleRow[];
  /** The chain hash of the prior seal (null = genesis). */
  readonly prevChainHash: string | null;
}

/** A computed seal checkpoint, ready to persist as an `audit_seal` row. */
export interface SealCheckpoint {
  readonly partition: string;
  readonly organizationId: string | null;
  readonly fromId: string;
  readonly toId: string;
  readonly eventCount: number;
  readonly prevChainHash: string | null;
  readonly chainHash: string;
  readonly algorithm: "sha256";
}

/**
 * Seal a closed partition into a chain checkpoint. Throws on an empty partition (a seal must cover
 * ≥1 event — the caller skips empty partitions). Pure: deterministic for the same input.
 */
export function sealPartition(input: SealInput): SealCheckpoint {
  if (input.events.length === 0) {
    throw new Error(`cannot seal empty partition ${input.partition}`);
  }
  const eventHashes = input.events.map((e) => e.hash);
  return {
    partition: input.partition,
    organizationId: input.organizationId,
    fromId: input.events[0]!.id,
    toId: input.events[input.events.length - 1]!.id,
    eventCount: input.events.length,
    prevChainHash: input.prevChainHash,
    chainHash: computeChainHash(input.prevChainHash, eventHashes),
    algorithm: "sha256",
  };
}

/** A break detected while verifying a seal chain — the partition + why it failed. */
export interface SealChainBreak {
  readonly partition: string;
  readonly reason: "chain_hash_mismatch" | "prev_link_mismatch";
}

/**
 * Verify an ordered seal chain against freshly-recomputed event hashes. For each seal: recompute
 * its chain hash from the current events and compare (detects an altered/inserted/removed event,
 * §12.3), and check its `prev_chain_hash` links to the prior seal (detects a removed/reordered
 * seal). Returns every break (empty = the chain is intact).
 */
export function verifySealChain(
  seals: readonly SealCheckpoint[],
  recomputeEventHashes: (partition: string) => readonly string[],
): SealChainBreak[] {
  const breaks: SealChainBreak[] = [];
  let prev: string | null = null;
  for (const seal of seals) {
    if (seal.prevChainHash !== prev) {
      breaks.push({ partition: seal.partition, reason: "prev_link_mismatch" });
    }
    const recomputed = computeChainHash(seal.prevChainHash, recomputeEventHashes(seal.partition));
    if (recomputed !== seal.chainHash) {
      breaks.push({ partition: seal.partition, reason: "chain_hash_mismatch" });
    }
    prev = seal.chainHash;
  }
  return breaks;
}

export * from "./chain-sample";
export * from "./db-chain-reader";
