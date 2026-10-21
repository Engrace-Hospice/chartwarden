// apps/backend/src/modules/04-audit/jobs/audit-integrity-job.ts — M4 §4.4 `audit.seal_partition` +
// `audit.integrity_sample`: the sealed audit hash chain and its sampled verification (the batch-11
// deferral of GAP-014).
//
//   • seal    — for each org, every CLOSED UTC month (ended ≥ 24 h ago, so a transaction that straddled
//               midnight has committed) gets one append-only `audit_seal`: a sha-256 chain over the month's
//               ordered per-row hashes, linked to the previous month's seal.
//   • sample  — verifies the chain end to end (the `prev_chain_hash` links are checked for EVERY seal) and
//               fully recomputes a bounded random subset of sealed months — always including the newest —
//               from the live rows. Any divergence is a tamper signal.
//
// FAIL CLOSED. A mismatch (1) commits an append-only `audit_integrity_run` row with the broken partitions,
// (2) writes an `audit.integrity_mismatch` critical audit event in the same transaction, (3) raises an M36
// alert, and (4) THROWS so the BullMQ job is failed and retried/DLQ'd instead of reporting green. A failure
// to raise the alert is thrown too — after the evidence row is committed — never swallowed. The report route
// reads the same rows, so `GET /audit/integrity/report` shows `contiguous: false`.
//
// GATING. The seal is the spec's Phase-2 control (`audit_hash_chain_enabled`, D2, default OFF). Disabled =>
// nothing is sealed and a `skipped` run row says so (never a clean-looking pass).
//
// WHAT IS NOT DONE. The spec's reference for the sample is a pgBackRest backup. That reader does not exist
// in this repo (external factor), so every run records `backup_cross_reference =
// 'unavailable_no_backup_reader'`; the seal chain is the independent reference instead. It is stored in the
// same database: it detects tampering by anything that cannot rewrite BOTH the rows and the seals (the app
// role cannot — audit_event and audit_seal are append-only for it), not a superuser who edits both.
import {
  type AuditChainReader,
  type ChainBreak,
  type StoredSeal,
  audit,
  compareSealToRecomputed,
  monthBounds,
  monthForPartitionName,
  monthOf,
  partitionNameForMonth,
  selectSealSample,
  verifySealLinkage,
} from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

const SEAL = schema.auditSeals;
const RUN = schema.auditIntegrityRuns;
const CERT = schema.destructionCertificates;

/** §4.4: "sample 100 events" — here, up to this many sealed months are recomputed per run. */
export const DEFAULT_SEAL_SAMPLE_SIZE = 3;
/** A month is sealed only once it ended this long ago (a tx that straddled midnight has committed). */
export const SEAL_GRACE_MS = 24 * 60 * 60 * 1000;
export const BACKUP_CROSS_REFERENCE_UNAVAILABLE = "unavailable_no_backup_reader";
/** The M36 alert type (a platform-default `alert_rule` — packages/messaging seed). */
export const AUDIT_INTEGRITY_ALERT_TYPE = "m4.audit.integrity_mismatch";
export const AUDIT_INTEGRITY_MISMATCH_ACTION = "audit.integrity_mismatch";

const SYSTEM = { userId: "" } as const;
const DESTROYED_STATUSES = ["executed", "partial_refused"] as const;
const AUDIT_DATA_CLASS_PREFIX = "audit_event.";

export interface AuditIntegrityAlertPort {
  emit(
    organizationId: string,
    input: {
      eventType: string;
      payload: Record<string, unknown>;
      severity: string;
      correlationId: string;
    },
  ): Promise<unknown>;
}

export interface AuditIntegrityDeps {
  readonly db: DbClient;
  readonly listOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly reader: AuditChainReader;
  readonly alerts: AuditIntegrityAlertPort;
  /** The `audit_hash_chain_enabled` flag for an org (default OFF per M4 D2). */
  readonly isHashChainEnabled: (organizationId: string) => Promise<boolean> | boolean;
  readonly sampleSize?: number;
  readonly random?: () => number;
  readonly now?: () => Date;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

/** Raised by the sample job when the chain does not verify — the job must FAIL, not report green. */
export class AuditIntegrityMismatchError extends Error {
  constructor(
    readonly organizationId: string,
    readonly breaks: readonly ChainBreak[],
  ) {
    super(
      `M4_AUDIT_INTEGRITY: org ${organizationId} audit hash chain does not verify (${breaks
        .map((b) => `${b.partition}:${b.reason}`)
        .join(", ")})`,
    );
    this.name = "AuditIntegrityMismatchError";
  }
}

/** First instant of the UTC month containing `now - grace`: months strictly before it are sealable. */
export const sealableBefore = (now: Date): Date => {
  const t = new Date(now.getTime() - SEAL_GRACE_MS);
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
};

async function listSeals(db: DbClient, organizationId: string): Promise<StoredSeal[]> {
  const rows = await withOrgContext(db, { organizationId, ...SYSTEM }, (tx) =>
    tx
      .select({
        partition: SEAL.partition,
        prevChainHash: SEAL.prevChainHash,
        chainHash: SEAL.chainHash,
        eventCount: SEAL.eventCount,
        fromId: SEAL.fromId,
        toId: SEAL.toId,
      })
      .from(SEAL)
      .where(eq(SEAL.organizationId, organizationId))
      .orderBy(asc(SEAL.partition)),
  );
  return rows;
}

/** UTC months touched by an executed / partially-refused audit destruction certificate. */
async function destroyedMonths(db: DbClient, organizationId: string): Promise<Set<string>> {
  const certs = await withOrgContext(db, { organizationId, ...SYSTEM }, (tx) =>
    tx
      .select({
        dataClass: CERT.dataClass,
        start: CERT.dateRangeStart,
        end: CERT.dateRangeEnd,
      })
      .from(CERT)
      .where(
        and(eq(CERT.organizationId, organizationId), inArray(CERT.status, [...DESTROYED_STATUSES])),
      ),
  );
  const months = new Set<string>();
  for (const c of certs) {
    if (!c.dataClass.startsWith(AUDIT_DATA_CLASS_PREFIX)) continue;
    const cursor = new Date(Date.UTC(c.start.getUTCFullYear(), c.start.getUTCMonth(), 1));
    while (cursor <= c.end) {
      months.add(monthOf(cursor));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return months;
}

interface RunRecord {
  readonly kind: "sample" | "seal";
  readonly result: "match" | "mismatch" | "skipped" | "error";
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly partitionsSealed?: number;
  readonly sealsTotal?: number;
  readonly sealsSampled?: number;
  readonly eventsHashed?: number;
  readonly mismatches?: number;
  readonly detail: Record<string, unknown>;
}

/** Append the run row (and, on a mismatch, the critical audit event) in ONE transaction. */
async function recordRun(
  deps: AuditIntegrityDeps,
  organizationId: string,
  run: RunRecord,
): Promise<string> {
  return withOrgContext(deps.db, { organizationId, ...SYSTEM }, async (tx) => {
    const [row] = await tx
      .insert(RUN)
      .values({
        organizationId,
        kind: run.kind,
        result: run.result,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        partitionsSealed: run.partitionsSealed ?? 0,
        sealsTotal: run.sealsTotal ?? 0,
        sealsSampled: run.sealsSampled ?? 0,
        eventsHashed: run.eventsHashed ?? 0,
        mismatches: run.mismatches ?? 0,
        backupCrossReference: BACKUP_CROSS_REFERENCE_UNAVAILABLE,
        detail: run.detail,
      })
      .returning({ id: RUN.id });
    if (!row) throw new Error("audit_integrity_run insert returned no row");
    if (run.result === "mismatch") {
      await audit(
        tx,
        { organizationId, userId: null, actorKind: "system", correlationId: row.id },
        {
          eventType: AUDIT_INTEGRITY_MISMATCH_ACTION,
          resourceKind: "audit_integrity_run",
          resourceId: row.id,
          outcome: "failure",
          severity: "critical",
          retentionClass: "compliance",
          context: { mismatches: run.mismatches ?? 0, breaks: run.detail.breaks ?? [] },
        },
      );
    }
    return row.id;
  });
}

export interface SealOutcome {
  readonly sealed: readonly string[];
  /** Closed months older than the newest seal that hold events but no seal (cannot be linked in order). */
  readonly unsealedOlder: readonly string[];
}

/** Seal every closed month after the newest seal, in order, each linked to its predecessor. */
export async function sealOutstandingMonths(
  deps: AuditIntegrityDeps,
  organizationId: string,
  now: Date,
): Promise<SealOutcome> {
  const months = await deps.reader.listClosedMonths(organizationId, sealableBefore(now));
  const seals = await listSeals(deps.db, organizationId);
  const sealedMonths = new Set(seals.map((s) => monthForPartitionName(s.partition)));
  const newest = seals[seals.length - 1];
  const newestMonth = newest ? monthForPartitionName(newest.partition) : null;
  const unsealedOlder = months.filter(
    (m) => !sealedMonths.has(m) && newestMonth !== null && m < newestMonth,
  );
  let prevChainHash = newest?.chainHash ?? null;
  const sealed: string[] = [];
  for (const month of months) {
    if (sealedMonths.has(month) || (newestMonth !== null && month < newestMonth)) continue;
    const digest = await deps.reader.digestMonth(organizationId, month, prevChainHash);
    if (!digest || !digest.fromId || !digest.toId) continue;
    const inserted = await withOrgContext(deps.db, { organizationId, ...SYSTEM }, (tx) =>
      tx
        .insert(SEAL)
        .values({
          organizationId,
          partition: partitionNameForMonth(month),
          fromId: digest.fromId as string,
          toId: digest.toId as string,
          eventCount: digest.eventCount,
          prevChainHash,
          chainHash: digest.chainHash,
          algorithm: "sha256",
        })
        .onConflictDoNothing()
        .returning({ id: SEAL.id }),
    );
    // A concurrent sealer won this month: stop, the next tick re-reads the chain head.
    if (inserted.length === 0) break;
    sealed.push(month);
    prevChainHash = digest.chainHash;
  }
  return { sealed, unsealedOlder };
}

/** `audit.seal_partition` for one org. Inert (and recorded as such by the sample) when the flag is off. */
export async function runSealPartitionsForOrg(
  deps: AuditIntegrityDeps,
  organizationId: string,
): Promise<{ sealed: readonly string[] }> {
  if (!(await deps.isHashChainEnabled(organizationId))) return { sealed: [] };
  const now = (deps.now ?? (() => new Date()))();
  const startedAt = now;
  const outcome = await sealOutstandingMonths(deps, organizationId, now);
  if (outcome.sealed.length > 0) {
    await recordRun(deps, organizationId, {
      kind: "seal",
      result: "match",
      startedAt,
      finishedAt: (deps.now ?? (() => new Date()))(),
      partitionsSealed: outcome.sealed.length,
      detail: { sealed: outcome.sealed },
    });
  }
  return { sealed: outcome.sealed };
}

export interface IntegritySampleOutcome {
  readonly runId: string;
  readonly result: "match" | "mismatch" | "skipped";
  readonly sealsTotal: number;
  readonly sealsSampled: number;
  readonly eventsHashed: number;
  readonly breaks: readonly ChainBreak[];
}

/** Recompute the sampled months and collect every break (never short-circuits on the first). */
async function verifyChain(
  deps: AuditIntegrityDeps,
  organizationId: string,
  now: Date,
): Promise<{
  breaks: ChainBreak[];
  sealsTotal: number;
  sampled: string[];
  eventsHashed: number;
  skippedDestroyed: string[];
  sealed: string[];
}> {
  const outcome = await sealOutstandingMonths(deps, organizationId, now);
  const seals = await listSeals(deps.db, organizationId);
  const destroyed = await destroyedMonths(deps.db, organizationId);
  const breaks: ChainBreak[] = [
    ...verifySealLinkage(seals),
    ...outcome.unsealedOlder.map(
      (m): ChainBreak => ({ partition: partitionNameForMonth(m), reason: "unsealed_closed_month" }),
    ),
  ];
  const skippedDestroyed = seals
    .filter((s) => destroyed.has(monthForPartitionName(s.partition)))
    .map((s) => s.partition);
  const eligible = seals.filter((s) => !destroyed.has(monthForPartitionName(s.partition)));
  const sample = selectSealSample(
    eligible,
    deps.sampleSize ?? DEFAULT_SEAL_SAMPLE_SIZE,
    deps.random,
  );
  let eventsHashed = 0;
  for (const seal of sample) {
    const month = monthForPartitionName(seal.partition);
    monthBounds(month); // refuses a malformed partition name before it reaches SQL
    const recomputed = await deps.reader.digestMonth(organizationId, month, seal.prevChainHash);
    if (!recomputed) {
      breaks.push({ partition: seal.partition, reason: "event_count_mismatch" });
      continue;
    }
    eventsHashed += recomputed.eventCount;
    const reason = compareSealToRecomputed(seal, recomputed);
    if (reason) breaks.push({ partition: seal.partition, reason });
  }
  return {
    breaks,
    sealsTotal: seals.length,
    sampled: sample.map((s) => s.partition),
    eventsHashed,
    skippedDestroyed,
    sealed: [...outcome.sealed],
  };
}

/**
 * `audit.integrity_sample` for one org. Returns the outcome on `match` / `skipped`; on a mismatch it
 * records the evidence, raises the alert and throws {@link AuditIntegrityMismatchError}.
 */
export async function runIntegritySampleForOrg(
  deps: AuditIntegrityDeps,
  organizationId: string,
): Promise<IntegritySampleOutcome> {
  const clock = deps.now ?? (() => new Date());
  const startedAt = clock();
  if (!(await deps.isHashChainEnabled(organizationId))) {
    const runId = await recordRun(deps, organizationId, {
      kind: "sample",
      result: "skipped",
      startedAt,
      finishedAt: clock(),
      detail: { reason: "audit_hash_chain_enabled is off for this organization" },
    });
    return {
      runId,
      result: "skipped",
      sealsTotal: 0,
      sealsSampled: 0,
      eventsHashed: 0,
      breaks: [],
    };
  }

  let verified: Awaited<ReturnType<typeof verifyChain>>;
  try {
    verified = await verifyChain(deps, organizationId, startedAt);
  } catch (error) {
    // The run itself failed (database/reader fault): leave a durable `error` row, then rethrow.
    await recordRun(deps, organizationId, {
      kind: "sample",
      result: "error",
      startedAt,
      finishedAt: clock(),
      detail: { message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }

  const mismatch = verified.breaks.length > 0;
  const runId = await recordRun(deps, organizationId, {
    kind: "sample",
    result: mismatch ? "mismatch" : "match",
    startedAt,
    finishedAt: clock(),
    partitionsSealed: verified.sealed.length,
    sealsTotal: verified.sealsTotal,
    sealsSampled: verified.sampled.length,
    eventsHashed: verified.eventsHashed,
    mismatches: verified.breaks.length,
    detail: {
      breaks: verified.breaks,
      sampled: verified.sampled,
      skippedDestroyed: verified.skippedDestroyed,
    },
  });

  if (!mismatch) {
    return {
      runId,
      result: "match",
      sealsTotal: verified.sealsTotal,
      sealsSampled: verified.sampled.length,
      eventsHashed: verified.eventsHashed,
      breaks: [],
    };
  }

  // Evidence is committed. The alert goes out next; if THAT fails the job still fails (loudly).
  await deps.alerts.emit(organizationId, {
    eventType: AUDIT_INTEGRITY_ALERT_TYPE,
    severity: "critical",
    correlationId: `m4-integrity:${runId}`,
    payload: {
      runId,
      mismatches: verified.breaks.length,
      partitions: verified.breaks.map((b) => ({ partition: b.partition, reason: b.reason })),
    },
  });
  deps.log?.("m4.audit_integrity.mismatch", { organizationId, runId, breaks: verified.breaks });
  throw new AuditIntegrityMismatchError(organizationId, verified.breaks);
}

/** Latest run of each kind plus the live seal chain — the report route's read model. */
export async function readIntegrityState(
  db: DbClient,
  organizationId: string,
): Promise<{
  seals: StoredSeal[];
  lastSample: typeof RUN.$inferSelect | null;
}> {
  const seals = await listSeals(db, organizationId);
  const lastSample = await withOrgContext(db, { organizationId, ...SYSTEM }, async (tx) => {
    const rows = await tx
      .select()
      .from(RUN)
      .where(and(eq(RUN.organizationId, organizationId), eq(RUN.kind, "sample")))
      .orderBy(desc(RUN.finishedAt))
      .limit(1);
    return rows[0] ?? null;
  });
  return { seals, lastSample };
}
