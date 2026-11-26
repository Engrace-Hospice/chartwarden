import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

const BATCH = schema.intakeUploadBatches;
const CP = schema.classifiedPages;
const EJ = schema.extractionJobs;

export interface WardenLensBacklogCounts {
  readonly awaitingCapability: number;
  readonly reviewBacklog: number;
  readonly stalledProcessing: number;
}

/** Counts only; the Prometheus caller never receives tenant, batch, document or patient identifiers. */
export async function readWardenLensBacklogForOrg(
  db: DbClient,
  organizationId: string,
  now = new Date(),
): Promise<WardenLensBacklogCounts> {
  const stalledBefore = new Date(now.getTime() - 15 * 60_000);
  return withOrgContext(db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as DbClient;
    const [[awaitingJobs], [awaitingClassification], [review], [stalled]] = await Promise.all([
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(EJ)
        .innerJoin(CP, eq(CP.id, EJ.classifiedPageId))
        .where(eq(EJ.status, "awaiting_capability")),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(BATCH)
        .where(sql`${BATCH.auditMetadata} ? 'classificationAwaitingCapability'`),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(BATCH)
        .where(inArray(BATCH.status, ["extraction_complete", "in_review"])),
      tx
        .select({ count: sql<number>`count(*)::int` })
        .from(BATCH)
        .where(
          and(
            // `uploaded` may legitimately await a human trigger; only entered processing stages are stalled.
            inArray(BATCH.status, ["docling_complete", "classifier_complete"]),
            lt(BATCH.uploadedAt, stalledBefore),
          ),
        ),
    ]);
    return {
      awaitingCapability:
        (awaitingJobs?.count ?? 0) + (awaitingClassification?.count ?? 0),
      reviewBacklog: review?.count ?? 0,
      stalledProcessing: stalled?.count ?? 0,
    };
  });
}
