// apps/backend/src/modules/30-quality/cahps/export-job-store.ts — GAP-087. The `cahps_export_job` data access:
// the R-14 create (idempotent on the live job), the worker's lifecycle port (`CahpsExportJobPort`), the R-15 view
// mapping and the sealed-file read behind `GET .../export/:exportId/file`.
//
// Every statement runs in `withOrgContext` on the job's own org (RLS scopes it to `app.org_id`), with an explicit
// `organization_id` predicate as the belt. The rendered file is stored ONLY as a tenant-DEK envelope
// (`file_cipher`); the plaintext exists in memory for the render/push and for a download response.
import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import type { CahpsExportJob, CahpsExportJobPort } from "@chartwarden/quality";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import type { CahpsExportJobView } from "../routes/read-service";
import type { CahpsPhiCipher } from "./phi-cipher";

const J = schema.cahpsExportJob;
type JobRow = typeof J.$inferSelect;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** A worker / seam read names no acting human (the M4 audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

/** The route that serves a completed export's file (replaces a signed object-store URL). */
export const cahpsExportFilePath = (exportId: string): string =>
  `/api/v1/quality/cahps/export/${exportId}/file`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Row → the R-15 view. `downloadUrl` is present only once the artifact exists. */
export function toCahpsExportJobView(row: JobRow): CahpsExportJobView {
  return {
    exportId: row.id,
    organizationId: row.organizationId,
    vendorAdapterId: row.vendorAdapterId,
    samplePeriodStart: row.samplePeriodStart,
    samplePeriodEnd: row.samplePeriodEnd,
    status: row.status as CahpsExportJobView["status"],
    decedentCount: row.decedentCount,
    downloadUrl: row.status === "completed" ? cahpsExportFilePath(row.id) : null,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
    failureReason: row.failureReason,
  };
}

/**
 * Create the R-14 job inside the caller's tx. A LIVE (queued/running) job for the same org + cycle is returned
 * instead of a second one (partial unique index `cahps_export_job_live_uq`), so a retry or double-click converges.
 */
export async function createOrGetLiveExportJob(
  tx: DbClient,
  input: {
    readonly organizationId: string;
    readonly vendorBindingId: string;
    readonly vendorAdapterId: string;
    readonly samplingCycleMonth: string;
    readonly samplePeriodStart: string;
    readonly samplePeriodEnd: string;
    readonly decedentCount: number;
    readonly requestedByUserId: string | null;
  },
): Promise<{ readonly row: JobRow; readonly created: boolean }> {
  const [inserted] = await tx
    .insert(J)
    .values({ ...input, status: "queued" })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { row: inserted, created: true };
  const [live] = await tx
    .select()
    .from(J)
    .where(
      and(
        eq(J.organizationId, input.organizationId),
        eq(J.samplingCycleMonth, input.samplingCycleMonth),
        inArray(J.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (!live) throw new Error("cahps_export_job insert conflicted but no live job was found");
  return { row: live, created: false };
}

/** R-15 — one job in the org, or null. */
export async function getExportJob(
  db: DbClient,
  organizationId: string,
  exportId: string,
): Promise<JobRow | null> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [row] = await (tx as Tx)
      .select()
      .from(J)
      .where(and(eq(J.organizationId, organizationId), eq(J.id, exportId)))
      .limit(1);
    return row ?? null;
  });
}

/** The decrypted artifact behind `GET .../export/:exportId/file`; null while not completed / unknown. */
export async function readExportFile(
  db: DbClient,
  cipher: CahpsPhiCipher,
  organizationId: string,
  exportId: string,
): Promise<{ filename: string; mimeType: string; bytes: Buffer } | null> {
  const row = await getExportJob(db, organizationId, exportId);
  if (!row || row.status !== "completed" || !row.fileCipher || !row.filename || !row.mimeType) {
    return null;
  }
  const bytes = await cipher.decrypt(
    organizationId,
    "cahps_export_job.file_cipher",
    row.fileCipher,
  );
  return { filename: row.filename, mimeType: row.mimeType, bytes };
}

export interface CahpsExportJobPortDeps {
  readonly db: DbClient;
  readonly cipher: CahpsPhiCipher;
  readonly now?: () => Date;
}

/**
 * The worker's lifecycle port over the job row. Every transition is org-scoped and a no-op for a job that is not
 * in the expected predecessor state, so a redelivered BullMQ job cannot resurrect a terminal row.
 */
export function buildCahpsExportJobPort(deps: CahpsExportJobPortDeps): CahpsExportJobPort {
  const now = deps.now ?? (() => new Date());
  const inOrg = <T>(
    job: CahpsExportJob,
    fn: (tx: Tx, exportId: string) => Promise<T>,
  ): Promise<T> => {
    if (!job.exportId) throw new Error("cahps export job port called without an exportId");
    const exportId = job.exportId;
    return withOrgContext(
      deps.db,
      { organizationId: job.organizationId, userId: SYSTEM_USER_ID },
      (tx) => fn(tx as Tx, exportId),
    );
  };
  const mine = (job: CahpsExportJob, exportId: string) =>
    and(eq(J.organizationId, job.organizationId), eq(J.id, exportId));

  return {
    async markRunning(job) {
      await inOrg(job, (tx, exportId) =>
        tx
          .update(J)
          .set({ status: "running", startedAt: now() })
          .where(and(mine(job, exportId), inArray(J.status, ["queued", "running"]))),
      );
    },
    async storeFile(job, file, decedentCount) {
      const sealed = await deps.cipher.encrypt(
        job.organizationId,
        "cahps_export_job.file_cipher",
        file.bytes,
      );
      await inOrg(job, (tx, exportId) =>
        tx
          .update(J)
          .set({
            filename: file.filename,
            mimeType: file.mimeType,
            fileCipher: sealed.envelope,
            fileSha256: createHash("sha256").update(file.bytes).digest("hex"),
            decedentCount,
          })
          .where(and(mine(job, exportId), inArray(J.status, ["queued", "running"]))),
      );
    },
    async complete(job, push) {
      await inOrg(job, (tx, exportId) =>
        tx
          .update(J)
          .set({
            status: "completed",
            pushStatus: push.status,
            vendorJobId: push.status === "pushed" ? push.vendorJobId : null,
            completedAt: now(),
            failureReason: null,
          })
          .where(and(mine(job, exportId), inArray(J.status, ["queued", "running"]))),
      );
    },
    async fail(job, reason) {
      await inOrg(job, (tx, exportId) =>
        tx
          .update(J)
          .set({ status: "failed", failureReason: reason.slice(0, 500), completedAt: now() })
          .where(and(mine(job, exportId), inArray(J.status, ["queued", "running"]))),
      );
    },
  };
}
