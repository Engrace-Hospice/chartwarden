// apps/backend/src/modules/22-documents/extraction/privacy-sud-batches.ts — M22's answer to M5's Privacy
// Officer port `IntakeSudBatchReader` (M5 §5.1 "Privacy flags"; M22 §7.4 W4). Bound at the composition
// root: M5 has no `dependsOn` edge to M22 and cannot read `intake_upload_batch` itself.
//
// Returns the patient's intake batches whose SUD state is `detected`, `confirmed` or `rejected` — ids, the SUD
// state, the batch's pipeline status, when the packet arrived, its page count, and when a reviewer resolved
// the detection. NEVER the detection evidence (`sud_evidence_cipher`), the resolution reason, or any page
// content: the officer page links to the intake review (`/intake/:batchId/review`), where a licensed
// reviewer sees the evidence under its own permission.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { IntakeSudBatchFact, IntakeSudBatchReader } from "../../05-patient/index";

const BATCH = schema.intakeUploadBatches;
const CP = schema.classifiedPages;

export function buildIntakeSudBatchReader(db: DbClient): IntakeSudBatchReader {
  return {
    async sudBatchesForPatient(organizationId, patientId): Promise<IntakeSudBatchFact[]> {
      return withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const batches = await tx
          .select({
            id: BATCH.id,
            sudStatus: BATCH.sudStatus,
            status: BATCH.status,
            uploadedAt: BATCH.uploadedAt,
            sudResolvedAt: BATCH.sudResolvedAt,
            geometryPages: sql<
              number | null
            >`CASE WHEN jsonb_typeof(${BATCH.pageGeometry}) = 'array' THEN jsonb_array_length(${BATCH.pageGeometry}) END`,
          })
          .from(BATCH)
          .where(
            and(
              eq(BATCH.patientId, patientId),
              inArray(BATCH.sudStatus, ["detected", "confirmed", "rejected"]),
            ),
          )
          .orderBy(desc(BATCH.uploadedAt), desc(BATCH.id))
          .limit(200);
        if (batches.length === 0) return [];
        const pages = await tx
          .select({
            batchId: CP.intakeUploadBatchId,
            lastPage: sql<number>`max(${CP.pageRangeEnd})::int`,
          })
          .from(CP)
          .where(
            inArray(
              CP.intakeUploadBatchId,
              batches.map((b) => b.id),
            ),
          )
          .groupBy(CP.intakeUploadBatchId);
        const lastPage = new Map(pages.map((p) => [p.batchId, Number(p.lastPage)]));
        return batches.map((b) => ({
          batchId: b.id,
          sudStatus: b.sudStatus as IntakeSudBatchFact["sudStatus"],
          batchStatus: String(b.status),
          receivedAt: b.uploadedAt.toISOString(),
          pageCount:
            lastPage.get(b.id) ?? (b.geometryPages === null ? null : Number(b.geometryPages)),
          resolvedAt: b.sudResolvedAt ? b.sudResolvedAt.toISOString() : null,
        }));
      });
    },
  };
}
