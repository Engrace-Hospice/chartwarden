// apps/backend/src/modules/28-fhir/jobs/export-store.ts — the Drizzle reads/writes the bulk-export worker and
// its sweeper run (GAP-084). Only M28's OWN tables: `fhir_bulk_export_job`, `fhir_bulk_export_artifact`,
// `fhir_client`, `tenant_fhir_config`.
//
// Workers are not requests: every function opens its own `withOrgContext` for the org it was handed (RLS is
// the wall) and keeps the explicit `organization_id` predicate as the second one. `userId: ""` is the system
// actor (the audit trigger maps it to NULL).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

const JOB = schema.fhirBulkExportJob;
const ARTIFACT = schema.fhirBulkExportArtifact;
const CLIENT = schema.fhirClient;
const CONFIG = schema.tenantFhirConfig;

const SYSTEM_USER_ID = "";
const asTx = (tx: unknown): DbClient => tx as DbClient;

/** The job as the worker needs it — the request, frozen at accept time. */
export interface ExportJobRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly clientId: string;
  readonly requestKind: "system" | "group" | "patient";
  readonly groupId: string | null;
  readonly patientIds: readonly string[] | null;
  readonly resourceTypes: readonly string[];
  readonly since: Date | null;
  readonly initiatedByMembershipId: string | null;
}

/** The client's CURRENT registry state — what the worker re-checks at execution time. */
export interface ExportClientRecord {
  readonly id: string;
  readonly status: string;
  readonly allowedScopes: readonly string[];
  readonly baaContractReference: string;
}

export interface ExportArtifactRecord {
  readonly resourceType: string;
  readonly objectKey: string;
  readonly byteSize: number;
  readonly rowCount: number;
  readonly checksumSha256: string;
}

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

const toJobRecord = (row: typeof JOB.$inferSelect): ExportJobRecord => ({
  id: row.id,
  organizationId: row.organizationId,
  clientId: row.clientId,
  requestKind: row.requestKind as ExportJobRecord["requestKind"],
  groupId: row.groupId,
  patientIds: row.patientIds === null ? null : strings(row.patientIds),
  resourceTypes: strings(row.resourceTypes),
  since: row.sinceIso,
  initiatedByMembershipId: row.initiatedByMembershipId,
});

/** `accepted -> in_progress`, exactly once: a second claim (duplicate delivery) gets null. */
export async function claimExportJob(
  db: DbClient,
  organizationId: string,
  jobId: string,
  at: Date,
): Promise<ExportJobRecord | null> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [row] = await asTx(tx)
      .update(JOB)
      .set({ status: "in_progress", startedAt: at })
      .where(
        and(eq(JOB.id, jobId), eq(JOB.organizationId, organizationId), eq(JOB.status, "accepted")),
      )
      .returning();
    return row ? toJobRecord(row) : null;
  });
}

export async function loadExportClient(
  db: DbClient,
  organizationId: string,
  clientId: string,
): Promise<ExportClientRecord | null> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [row] = await asTx(tx)
      .select()
      .from(CLIENT)
      .where(and(eq(CLIENT.id, clientId), eq(CLIENT.organizationId, organizationId)))
      .limit(1);
    return row
      ? {
          id: row.id,
          status: row.status,
          allowedScopes: strings(row.allowedScopes),
          baaContractReference: row.baaContractReference,
        }
      : null;
  });
}

export async function loadExportConfig(
  db: DbClient,
  organizationId: string,
): Promise<{ tenantFhirHost: string; identifierUriBase: string } | null> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [row] = await asTx(tx)
      .select({ host: CONFIG.tenantFhirHost, base: CONFIG.identifierUriBase })
      .from(CONFIG)
      .where(eq(CONFIG.organizationId, organizationId))
      .limit(1);
    return row ? { tenantFhirHost: row.host, identifierUriBase: row.base } : null;
  });
}

export async function exportJobStatus(
  db: DbClient,
  organizationId: string,
  jobId: string,
): Promise<string | null> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [row] = await asTx(tx)
      .select({ status: JOB.status })
      .from(JOB)
      .where(and(eq(JOB.id, jobId), eq(JOB.organizationId, organizationId)))
      .limit(1);
    return row?.status ?? null;
  });
}

/** What the in-tx completion/failure/expiry steps publish. */
export interface ExportOutboxEvent {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
}

type TxPublisher = (tx: DbClient, event: ExportOutboxEvent) => Promise<void>;

/**
 * `in_progress -> completed`: artifact rows, the roll-up and the completed event commit together. Returns
 * false when the job is no longer `in_progress` (cancelled mid-run) — the caller then purges what it wrote.
 */
export async function completeExportJob(
  db: DbClient,
  organizationId: string,
  args: {
    readonly jobId: string;
    readonly artifacts: readonly ExportArtifactRecord[];
    readonly completedAt: Date;
    readonly expiresAt: Date;
    readonly totalResources: number;
    readonly artifactCount: number;
    readonly event: ExportOutboxEvent;
  },
  publish: TxPublisher,
): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const t = asTx(tx);
    const [done] = await t
      .update(JOB)
      .set({
        status: "completed",
        completedAt: args.completedAt,
        expiresAt: args.expiresAt,
        totalResources: args.totalResources,
        artifactCount: args.artifactCount,
        failureReason: null,
      })
      .where(
        and(
          eq(JOB.id, args.jobId),
          eq(JOB.organizationId, organizationId),
          eq(JOB.status, "in_progress"),
        ),
      )
      .returning({ id: JOB.id });
    if (!done) return false;
    if (args.artifacts.length > 0) {
      await t.insert(ARTIFACT).values(
        args.artifacts.map((a) => ({
          organizationId,
          jobId: args.jobId,
          resourceType: a.resourceType,
          minioObjectKey: a.objectKey,
          byteSize: a.byteSize,
          rowCount: a.rowCount,
          checksumSha256: a.checksumSha256,
        })),
      );
    }
    await publish(t, args.event);
    return true;
  });
}

/** `in_progress -> failed`. Returns false when the job was already terminal (a no-op, never an overwrite). */
export async function failExportJob(
  db: DbClient,
  organizationId: string,
  jobId: string,
  reason: string,
  event: ExportOutboxEvent,
  publish: TxPublisher,
): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const t = asTx(tx);
    const [row] = await t
      .update(JOB)
      .set({ status: "failed", failureReason: reason })
      .where(
        and(
          eq(JOB.id, jobId),
          eq(JOB.organizationId, organizationId),
          eq(JOB.status, "in_progress"),
        ),
      )
      .returning({ id: JOB.id });
    if (!row) return false;
    await publish(t, event);
    return true;
  });
}

export async function listJobArtifacts(
  db: DbClient,
  organizationId: string,
  jobId: string,
): Promise<readonly ExportArtifactRecord[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await asTx(tx)
      .select()
      .from(ARTIFACT)
      .where(and(eq(ARTIFACT.jobId, jobId), eq(ARTIFACT.organizationId, organizationId)))
      .orderBy(asc(ARTIFACT.resourceType));
    return rows.map((r) => ({
      resourceType: r.resourceType,
      objectKey: r.minioObjectKey,
      byteSize: r.byteSize,
      rowCount: r.rowCount,
      checksumSha256: r.checksumSha256,
    }));
  });
}

/** `completed` jobs whose `expires_at` has passed — the sweeper's work list, oldest first. */
export async function dueExpiredJobIds(
  db: DbClient,
  organizationId: string,
  now: Date,
  limit: number,
): Promise<readonly string[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await asTx(tx)
      .select({ id: JOB.id })
      .from(JOB)
      .where(
        and(
          eq(JOB.organizationId, organizationId),
          eq(JOB.status, "completed"),
          lte(JOB.expiresAt, now),
        ),
      )
      .orderBy(asc(JOB.expiresAt))
      .limit(limit);
    return rows.map((r) => r.id);
  });
}

/** `completed -> expired`, only once the objects are gone. Returns false when it was not `completed`. */
export async function markJobExpired(
  db: DbClient,
  organizationId: string,
  jobId: string,
): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await asTx(tx)
      .update(JOB)
      .set({ status: "expired" })
      .where(
        and(eq(JOB.id, jobId), eq(JOB.organizationId, organizationId), eq(JOB.status, "completed")),
      )
      .returning({ id: JOB.id });
    return rows.length > 0;
  });
}

/**
 * Jobs stuck `accepted` since before `olderThan` (their producer enqueue was lost) but not so old that the
 * request is stale — those are {@link abandonedAcceptedJobs}, cancelled rather than run.
 */
export async function orphanedAcceptedJobIds(
  db: DbClient,
  organizationId: string,
  window: { readonly olderThan: Date; readonly newerThan: Date },
  limit: number,
): Promise<readonly string[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await asTx(tx)
      .select({ id: JOB.id })
      .from(JOB)
      .where(
        and(
          eq(JOB.organizationId, organizationId),
          eq(JOB.status, "accepted"),
          lte(JOB.createdAt, window.olderThan),
          gt(JOB.createdAt, window.newerThan),
        ),
      )
      .orderBy(asc(JOB.createdAt))
      .limit(limit);
    return rows.map((r) => r.id);
  });
}

/** Jobs `accepted` since before `olderThan`: no worker ever existed to run them (pre-GAP-084 rows) or the
 *  request is too stale to honour. They are cancelled, which also releases the client's one-job slot. */
export async function abandonedAcceptedJobs(
  db: DbClient,
  organizationId: string,
  olderThan: Date,
  limit: number,
): Promise<readonly { id: string; clientId: string }[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    return asTx(tx)
      .select({ id: JOB.id, clientId: JOB.clientId })
      .from(JOB)
      .where(
        and(
          eq(JOB.organizationId, organizationId),
          eq(JOB.status, "accepted"),
          lte(JOB.createdAt, olderThan),
        ),
      )
      .orderBy(asc(JOB.createdAt))
      .limit(limit);
  });
}

/** `accepted -> cancelled` for an abandoned job. Returns false when it had moved on in the meantime. */
export async function cancelAbandonedJob(
  db: DbClient,
  organizationId: string,
  jobId: string,
  event: ExportOutboxEvent,
  publish: TxPublisher,
): Promise<boolean> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const t = asTx(tx);
    const [row] = await t
      .update(JOB)
      .set({ status: "cancelled" })
      .where(
        and(eq(JOB.id, jobId), eq(JOB.organizationId, organizationId), eq(JOB.status, "accepted")),
      )
      .returning({ id: JOB.id });
    if (!row) return false;
    await publish(t, event);
    return true;
  });
}

/** Jobs `in_progress` since before `startedBefore`: the worker that claimed them is gone. */
export async function stalledInProgressJobs(
  db: DbClient,
  organizationId: string,
  startedBefore: Date,
  limit: number,
): Promise<readonly { id: string; clientId: string }[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await asTx(tx)
      .select({ id: JOB.id, clientId: JOB.clientId })
      .from(JOB)
      .where(
        and(
          eq(JOB.organizationId, organizationId),
          eq(JOB.status, "in_progress"),
          lte(JOB.startedAt, startedBefore),
        ),
      )
      .orderBy(asc(JOB.startedAt))
      .limit(limit);
    return rows;
  });
}

/**
 * `expired` jobs that still hold an artifact whose object was never purged. The M4 offboarding eraser flips
 * every job to `expired` without touching MinIO (its own header says the purge is the sweeper's), so the
 * sweeper must reach those objects too — otherwise an offboarded tenant's NDJSON would outlive its erasure.
 */
export async function expiredJobIdsWithLiveArtifacts(
  db: DbClient,
  organizationId: string,
  limit: number,
): Promise<readonly string[]> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await asTx(tx)
      .selectDistinct({ id: ARTIFACT.jobId })
      .from(ARTIFACT)
      .innerJoin(JOB, eq(JOB.id, ARTIFACT.jobId))
      .where(
        and(
          eq(ARTIFACT.organizationId, organizationId),
          eq(JOB.status, "expired"),
          sql`${ARTIFACT.minioObjectKey} <> ''`,
        ),
      )
      .limit(limit);
    return rows.map((r) => r.id);
  });
}

/**
 * Record that one artifact's object is gone: the key is blanked (the row's size, count and checksum stay as
 * the disclosure-accounting evidence — §3.7 "minio_object_key purged ... row metadata persists"). A blank
 * key is also the sweeper's "already purged" marker, which is what makes a re-run a no-op.
 */
export async function markArtifactPurged(
  db: DbClient,
  organizationId: string,
  jobId: string,
  objectKey: string,
): Promise<void> {
  await withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    await asTx(tx)
      .update(ARTIFACT)
      .set({ minioObjectKey: "" })
      .where(
        and(
          eq(ARTIFACT.jobId, jobId),
          eq(ARTIFACT.organizationId, organizationId),
          eq(ARTIFACT.minioObjectKey, objectKey),
        ),
      );
  });
}
