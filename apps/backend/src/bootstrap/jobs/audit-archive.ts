// apps/backend/src/bootstrap/jobs/audit-archive.ts — the M1 `audit.archive` job (GAP-113; M1 spec §4.8, M4 §4.4).
//
// Monthly: move CLOSED `audit_event` month-partitions older than the hot window into object storage, verify the
// copy, and (only when an operator opted in) detach the partition from the hot table. Module 1 owns this
// MECHANISM; Module 4 owns the retention / legal-hold / destruction POLICY — so this job never drops anything
// (destruction is M4's certificate-driven act) and §4.8.1's rule "never drop a partition whose archive failed"
// holds trivially.
//
// PER PARTITION
//   1. read it in keyset pages (`audit_archive_read_batch`, migration 0432) and cut it into gzip'd NDJSON parts of
//      at most `rowsPerPart` rows — memory is bounded by one part, not by a month of audit trail;
//   2. PUT each part with a server-enforced SHA-256 (`putObject` with a mime type sets `x-amz-checksum-sha256`),
//      then INSPECT it back: the store's authoritative size + checksum must equal what was sent;
//   3. the archived row total must equal the partition's row count at selection time (a short read is a failure);
//   4. PUT + inspect a manifest naming every part, its row count, size and checksum;
//   5. only then, when `detach` is on, call `audit_archive_detach`, which re-counts and refuses on any mismatch.
// A failure on one partition never stops the others; the pass rejects at the end so BullMQ retries (every step is
// idempotent: the same closed partition produces the same bytes, so a re-PUT overwrites with identical content).
//
// UNCONFIGURED IS A SKIP, NOT A LOSS. With no archive bucket / object-store credentials the job reports
// `skipped: "unconfigured"` and touches nothing — the hot tier simply keeps the partitions.
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { AUDIT_QUEUES } from "@wardenx/audit";
import type { DbClient } from "@wardenx/db";
import {
  type PlatformBypassAuditor,
  registerPlatformJob,
  withPlatformContext,
} from "@wardenx/tenancy";
import { sql } from "drizzle-orm";

export const AUDIT_ARCHIVE_JOB_ID = "platform.audit_archive";
/** M1 spec §4.8 queue name — the audit catalog's `archive` entry (one declaration, so arch:queue-names sees one owner). */
export const AUDIT_ARCHIVE_QUEUE = AUDIT_QUEUES.archive;
/** Monthly, 03:30 on the 2nd (after the 1st's partition rotation has settled). */
export const AUDIT_ARCHIVE_CRON = "30 3 2 * *";
/** Closed partitions younger than this many months stay hot. */
export const DEFAULT_HOT_MONTHS = 13;
export const DEFAULT_ROWS_PER_PART = 20_000;
export const READ_PAGE_SIZE = 2_000;
/** Bounds the work of one run; the rest waits for the next (oldest first, so the backlog drains). */
export const DEFAULT_MAX_PARTITIONS_PER_RUN = 3;

export interface ArchiveCandidate {
  readonly partitionName: string;
  readonly rangeFrom: string;
  readonly rangeTo: string;
  readonly rowCount: number;
}

/** The three definer-rights functions of migration 0432, behind a port. */
export interface ArchiveCatalogPort {
  candidates(hotMonths: number): Promise<readonly ArchiveCandidate[]>;
  readBatch(
    partitionName: string,
    afterId: string | null,
    limit: number,
  ): Promise<ReadonlyArray<Record<string, unknown>>>;
  /**
   * `manifestVerified` attests the archive manifest was written AND read back verified: the SQL function refuses a partition
   * holding actively-held rows (GAP-008) without it. `archivePartition` passes true only after `putAndVerify` of the manifest.
   */
  detach(partitionName: string, expectedRows: number, manifestVerified: boolean): Promise<void>;
}

/** The slice of the object store the job needs (`ObjectStorePort`'s `putObject` + `inspectObject`). */
export interface ArchiveObjectPort {
  putObject(args: {
    bucket: string;
    objectKey: string;
    bytes: Uint8Array;
    mimeType?: string;
  }): Promise<{ sha256Hex: string }>;
  inspectObject(args: {
    bucket: string;
    objectKey: string;
  }): Promise<{ byteSize: number; sha256Hex: string } | null>;
}

export interface ArchivePartRecord {
  readonly key: string;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly firstId: string;
  readonly lastId: string;
}

export interface ArchiveManifest {
  readonly schemaVersion: 1;
  readonly table: "audit_event";
  readonly partition: string;
  readonly rangeFrom: string;
  readonly rangeTo: string;
  readonly rowCount: number;
  readonly parts: readonly ArchivePartRecord[];
  readonly archivedAt: string;
}

export interface ArchivedPartition {
  readonly partitionName: string;
  readonly rows: number;
  readonly parts: number;
  readonly manifestKey: string;
  readonly detached: boolean;
}

export class ArchiveVerificationError extends Error {
  constructor(message: string) {
    super(`AUDIT_ARCHIVE_VERIFICATION_FAILED: ${message}`);
    this.name = "ArchiveVerificationError";
  }
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const pad = (n: number): string => String(n).padStart(5, "0");

/** Object key layout: `<prefix>/audit_event/<partition>/part-00001.ndjson.gz` + `manifest.json`. */
export function partKey(prefix: string, partition: string, n: number): string {
  return `${prefix}/audit_event/${partition}/part-${pad(n)}.ndjson.gz`;
}
export const manifestKey = (prefix: string, partition: string): string =>
  `${prefix}/audit_event/${partition}/manifest.json`;

/** Gzip'd NDJSON for one part. Deterministic for a given row list (so a retry rewrites identical bytes). */
export function encodePart(rows: ReadonlyArray<Record<string, unknown>>): Uint8Array {
  const text = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
  // `mtime: 0` is the default for zlib's gzipSync — no timestamp in the header, so equal input -> equal bytes.
  return new Uint8Array(gzipSync(Buffer.from(text, "utf8")));
}

interface PutVerified {
  readonly sha256: string;
  readonly bytes: number;
}

/** PUT with a server-enforced checksum, then read the object's metadata back and compare. */
async function putAndVerify(
  store: ArchiveObjectPort,
  bucket: string,
  objectKey: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<PutVerified> {
  const local = sha256Hex(bytes);
  const put = await store.putObject({ bucket, objectKey, bytes, mimeType });
  if (put.sha256Hex !== local)
    throw new ArchiveVerificationError(
      `${objectKey}: store acknowledged ${put.sha256Hex}, sent ${local}`,
    );
  const seen = await store.inspectObject({ bucket, objectKey });
  if (!seen) throw new ArchiveVerificationError(`${objectKey}: not present after upload`);
  if (seen.sha256Hex !== local || seen.byteSize !== bytes.byteLength)
    throw new ArchiveVerificationError(
      `${objectKey}: stored ${seen.byteSize}B/${seen.sha256Hex}, expected ${bytes.byteLength}B/${local}`,
    );
  return { sha256: local, bytes: bytes.byteLength };
}

export interface ArchiveConfig {
  readonly bucket: string;
  readonly prefix: string;
  readonly rowsPerPart: number;
  readonly detach: boolean;
  readonly now?: () => Date;
}

/** Archive ONE partition end to end. Throws on any verification failure — the caller records it and moves on. */
export async function archivePartition(
  candidate: ArchiveCandidate,
  catalog: ArchiveCatalogPort,
  store: ArchiveObjectPort,
  config: ArchiveConfig,
): Promise<ArchivedPartition> {
  const parts: ArchivePartRecord[] = [];
  let buffer: Array<Record<string, unknown>> = [];
  let total = 0;
  let afterId: string | null = null;

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const key = partKey(config.prefix, candidate.partitionName, parts.length + 1);
    const bytes = encodePart(buffer);
    const verified = await putAndVerify(store, config.bucket, key, bytes, "application/gzip");
    parts.push({
      key,
      rows: buffer.length,
      bytes: verified.bytes,
      sha256: verified.sha256,
      firstId: String(buffer[0]?.id),
      lastId: String(buffer[buffer.length - 1]?.id),
    });
    buffer = [];
  };

  for (;;) {
    const page = await catalog.readBatch(candidate.partitionName, afterId, READ_PAGE_SIZE);
    if (page.length === 0) break;
    for (const row of page) {
      buffer.push(row);
      total += 1;
      if (buffer.length >= config.rowsPerPart) await flush();
    }
    afterId = String(page[page.length - 1]?.id);
  }
  await flush();

  if (total !== candidate.rowCount)
    throw new ArchiveVerificationError(
      `${candidate.partitionName}: read ${total} rows, partition held ${candidate.rowCount} when selected`,
    );

  const manifest: ArchiveManifest = {
    schemaVersion: 1,
    table: "audit_event",
    partition: candidate.partitionName,
    rangeFrom: candidate.rangeFrom,
    rangeTo: candidate.rangeTo,
    rowCount: total,
    parts,
    archivedAt: (config.now ?? (() => new Date()))().toISOString(),
  };
  const mKey = manifestKey(config.prefix, candidate.partitionName);
  await putAndVerify(
    store,
    config.bucket,
    mKey,
    new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    "application/json",
  );

  let detached = false;
  if (config.detach) {
    await catalog.detach(candidate.partitionName, total, true);
    detached = true;
  }
  return {
    partitionName: candidate.partitionName,
    rows: total,
    parts: parts.length,
    manifestKey: mKey,
    detached,
  };
}

export interface AuditArchiveDeps {
  /** Runs `fn` with a catalog bound to a platform-context transaction (one entry per call). */
  readonly withCatalog: <T>(fn: (catalog: ArchiveCatalogPort) => Promise<T>) => Promise<T>;
  readonly store: ArchiveObjectPort;
  readonly config: ArchiveConfig;
  readonly hotMonths: number;
  readonly maxPartitions?: number;
  readonly log?: (msg: string, detail: Record<string, unknown>) => void;
}

export interface AuditArchiveRun {
  readonly archived: readonly ArchivedPartition[];
  readonly failed: readonly { partitionName: string; error: string }[];
  /** Candidates left for the next run (the per-run cap). */
  readonly deferred: number;
}

export async function runAuditArchive(deps: AuditArchiveDeps): Promise<AuditArchiveRun> {
  const candidates = await deps.withCatalog((c) => c.candidates(deps.hotMonths));
  const cap = deps.maxPartitions ?? DEFAULT_MAX_PARTITIONS_PER_RUN;
  const batch = candidates.filter((c) => c.rowCount > 0).slice(0, cap);
  const archived: ArchivedPartition[] = [];
  const failed: { partitionName: string; error: string }[] = [];
  for (const candidate of batch) {
    try {
      const done = await deps.withCatalog((catalog) =>
        archivePartition(candidate, catalog, deps.store, deps.config),
      );
      archived.push(done);
      deps.log?.("audit.archive.partition_archived", { ...done });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ partitionName: candidate.partitionName, error });
      deps.log?.("audit.archive.partition_failed", {
        partitionName: candidate.partitionName,
        error,
      });
    }
  }
  const run = {
    archived,
    failed,
    deferred: Math.max(0, candidates.filter((c) => c.rowCount > 0).length - batch.length),
  };
  if (failed.length > 0)
    throw new AggregateError(
      failed.map((f) => new Error(`${f.partitionName}: ${f.error}`)),
      `AUDIT_ARCHIVE: ${failed.length} partition(s) failed; none of them was detached`,
    );
  return run;
}

// ── the SQL catalog (migration 0432's functions) ─────────────────────────────────────────────────

export function createSqlArchiveCatalog(tx: DbClient): ArchiveCatalogPort {
  return {
    async candidates(hotMonths) {
      const { rows } = await tx.execute(sql`SELECT * FROM audit_archive_candidates(${hotMonths})`);
      return (rows as Record<string, unknown>[]).map((r) => ({
        partitionName: String(r.partition_name),
        rangeFrom: String(r.range_from),
        rangeTo: String(r.range_to),
        rowCount: Number(r.row_count),
      }));
    },
    async readBatch(partitionName, afterId, limit) {
      const { rows } = await tx.execute(
        sql`SELECT audit_archive_read_batch AS r FROM audit_archive_read_batch(${partitionName}, ${afterId}::uuid, ${limit})`,
      );
      return (rows as Array<{ r: Record<string, unknown> }>).map((x) => x.r);
    },
    async detach(partitionName, expectedRows, manifestVerified) {
      await tx.execute(
        sql`SELECT audit_archive_detach(${partitionName}, ${expectedRows}::bigint, ${manifestVerified}::boolean)`,
      );
    },
  };
}

/**
 * Bind a catalog to the platform credential: the unit of work reads EVERY tenant's audit rows, so it enters
 * `withPlatformContext` with `crossTenant: true` (a critical-severity bypass audit row per partition).
 */
export function platformCatalogRunner(deps: {
  readonly platformDb: DbClient;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
}): AuditArchiveDeps["withCatalog"] {
  return (fn) =>
    withPlatformContext(
      deps.platformDb,
      {
        jobId: AUDIT_ARCHIVE_JOB_ID,
        reason: "archive closed audit_event partitions to object storage (M1 audit.archive)",
        crossTenant: true,
      },
      deps.auditBypass,
      async (tx) => fn(createSqlArchiveCatalog(tx as unknown as DbClient)),
    );
}

export function wireAuditArchiveTenancy(): void {
  registerPlatformJob(AUDIT_ARCHIVE_JOB_ID);
}

export interface AuditArchiveEnv {
  readonly AUDIT_ARCHIVE_BUCKET?: string;
  readonly AUDIT_ARCHIVE_PREFIX?: string;
  readonly AUDIT_ARCHIVE_HOT_MONTHS?: string;
  readonly AUDIT_ARCHIVE_DETACH?: string;
  readonly AUDIT_ARCHIVE_ROWS_PER_PART?: string;
}

/** Env -> config; `null` = not configured (the job skips). Detach is OFF unless explicitly "true". */
export function auditArchiveConfigFromEnv(
  env: AuditArchiveEnv,
): { config: ArchiveConfig; hotMonths: number } | null {
  const bucket = env.AUDIT_ARCHIVE_BUCKET?.trim();
  if (!bucket) return null;
  const months = Number(env.AUDIT_ARCHIVE_HOT_MONTHS);
  const rows = Number(env.AUDIT_ARCHIVE_ROWS_PER_PART);
  return {
    hotMonths: Number.isInteger(months) && months >= 1 ? months : DEFAULT_HOT_MONTHS,
    config: {
      bucket,
      prefix: (env.AUDIT_ARCHIVE_PREFIX?.trim() || "audit-archive").replace(/^\/+|\/+$/g, ""),
      rowsPerPart: Number.isInteger(rows) && rows >= 100 ? rows : DEFAULT_ROWS_PER_PART,
      detach: env.AUDIT_ARCHIVE_DETACH === "true",
    },
  };
}
