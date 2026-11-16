// M10 — DB reads that shape a submission batch for the manual-iQIES result screens: items with their
// assessment context, the CMS findings recorded from the Final Validation Report, and where each rejected
// assessment's correction stands. All run inside the caller's `withOrgContext` transaction (RLS-scoped).
import { type DbClient, schema } from "@chartwarden/db";
import type { HopeSubmissionItemStatus } from "@chartwarden/types";
import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import {
  MAX_CORRECTION_CHAIN,
  MAX_RESULT_EVENTS_PER_SUBMISSION,
  findingSeverity,
  resolveRejectedItem,
  terminalCorrection,
} from "./hope-submission-result";
import { canonicalUuidOrNull } from "./hope-uuid";
import type { HopeSubmissionFindingView, HopeSubmissionItemView } from "./routes/service";

const SUB = schema.hopeSubmissions;
const SUBITEM = schema.hopeSubmissionItems;
const RESULT = schema.hopeSubmissionResultEvents;
const ASSESS = schema.hopeAssessments;
export type SubmissionItemRow = typeof SUBITEM.$inferSelect;
// Skip `iqies_validation_result` (the raw XML payload): item reads that only render the view never need it.
const { iqiesValidationResult: _heavyItem, ...LIGHT_ITEM_COLUMNS } = getTableColumns(SUBITEM);
export const LIGHT_ITEM = LIGHT_ITEM_COLUMNS;
// Skip `acceptance_report` (the base64 ZIP + raw CMS results): a read, lock or write that only needs the batch's
// status/columns must not drag the package bytes through the connection.
const { acceptanceReport: _heavyReport, ...LIGHT_SUB_COLUMNS_ } = getTableColumns(SUB);
export const LIGHT_SUB_COLUMNS = LIGHT_SUB_COLUMNS_;
export type LightSubmissionColumns = Omit<typeof SUB.$inferSelect, "acceptanceReport">;

interface Standing {
  readonly correctionAssessmentId: string | null;
  readonly resolution: ReturnType<typeof resolveRejectedItem>;
}

/** Corrections supersede (a NEW assessment row; the original is never edited). The correction's latest
 * batch item decides the standing of the rejected original. Every read names `organizationId` beside its ids: RLS is the
 * guard on the app role, the predicate is the one that holds on a connection that bypasses it. */
export async function rejectedStandings(
  t: DbClient,
  organizationId: string,
  items: readonly Pick<SubmissionItemRow, "hopeAssessmentId" | "itemStatus">[],
): Promise<Map<string, Standing>> {
  const rejectedIds = [
    ...new Set(items.filter((i) => i.itemStatus === "rejected").map((i) => i.hopeAssessmentId)),
  ];
  const out = new Map<string, Standing>();
  if (rejectedIds.length === 0) return out;
  // Walk the chain level by level (original -> correction -> its correction ...), so a rejected correction
  // that was itself corrected does not leave the original stuck on "needs correction".
  const childOf = new Map<string, string>();
  let frontier = rejectedIds;
  for (let depth = 0; frontier.length > 0 && depth < MAX_CORRECTION_CHAIN; depth += 1) {
    const level = await t
      .select({ id: ASSESS.id, corrects: ASSESS.correctsAssessmentId })
      .from(ASSESS)
      .where(
        and(
          eq(ASSESS.organizationId, organizationId),
          inArray(ASSESS.correctsAssessmentId, frontier),
        ),
      )
      // newest first: the first child seen is the live correction; an older one is an abandoned attempt
      .orderBy(desc(ASSESS.createdAt), desc(ASSESS.id));
    frontier = [];
    for (const c of level) {
      if (!c.corrects || childOf.has(c.corrects)) continue;
      childOf.set(c.corrects, c.id);
      frontier.push(c.id);
    }
  }
  const terminalOf = new Map(rejectedIds.map((id) => [id, terminalCorrection(id, childOf)]));
  const correctionIds = [...new Set([...terminalOf.values()].filter((v): v is string => !!v))];
  const placed = correctionIds.length
    ? await t
        .select({ assessmentId: SUBITEM.hopeAssessmentId, status: SUBITEM.itemStatus })
        .from(SUBITEM)
        .where(
          and(
            eq(SUBITEM.organizationId, organizationId),
            inArray(SUBITEM.hopeAssessmentId, correctionIds),
          ),
        )
        .orderBy(asc(SUBITEM.createdAt))
    : [];
  for (const id of rejectedIds) {
    const correctionId = terminalOf.get(id) ?? null;
    const latest = correctionId
      ? placed.filter((p) => p.assessmentId === correctionId).at(-1)
      : null;
    out.set(id, {
      correctionAssessmentId: correctionId,
      resolution: resolveRejectedItem(
        correctionId
          ? { itemStatus: (latest?.status as HopeSubmissionItemStatus | undefined) ?? null }
          : null,
      ),
    });
  }
  return out;
}

/** Per-batch rejected-item resolution counts for the worklist KPIs. */
export async function resolutionCountsByBatch(
  t: DbClient,
  organizationId: string,
  batchIds: readonly string[],
): Promise<Map<string, { needs: number; inProgress: number; resubmitted: number }>> {
  const out = new Map<string, { needs: number; inProgress: number; resubmitted: number }>();
  if (batchIds.length === 0) return out;
  const rejected = await t
    .select({
      hopeSubmissionId: SUBITEM.hopeSubmissionId,
      hopeAssessmentId: SUBITEM.hopeAssessmentId,
      itemStatus: SUBITEM.itemStatus,
    })
    .from(SUBITEM)
    .where(
      and(
        eq(SUBITEM.organizationId, organizationId),
        inArray(SUBITEM.hopeSubmissionId, [...batchIds]),
      ),
    );
  const standings = await rejectedStandings(t, organizationId, rejected);
  for (const item of rejected) {
    if (item.itemStatus !== "rejected") continue;
    const c = out.get(item.hopeSubmissionId) ?? { needs: 0, inProgress: 0, resubmitted: 0 };
    const resolution = standings.get(item.hopeAssessmentId)?.resolution;
    if (resolution === "needs_correction") c.needs += 1;
    else if (resolution === "correction_in_progress") c.inProgress += 1;
    else if (resolution === "resubmitted") c.resubmitted += 1;
    out.set(item.hopeSubmissionId, c);
  }
  return out;
}

export async function loadSubmissionItems(
  t: DbClient,
  organizationId: string,
  submissionId: string,
): Promise<HopeSubmissionItemView[]> {
  const items = (await t
    .select(LIGHT_ITEM)
    .from(SUBITEM)
    .where(
      and(eq(SUBITEM.organizationId, organizationId), eq(SUBITEM.hopeSubmissionId, submissionId)),
    )
    .orderBy(asc(SUBITEM.createdAt), asc(SUBITEM.id))) as SubmissionItemRow[];
  const ids = items.map((i) => i.hopeAssessmentId);
  const assessments = ids.length
    ? await t
        .select({
          id: ASSESS.id,
          patientId: ASSESS.patientId,
          rfaKind: ASSESS.rfaKind,
          status: ASSESS.status,
        })
        .from(ASSESS)
        .where(and(eq(ASSESS.organizationId, organizationId), inArray(ASSESS.id, ids)))
    : [];
  const standings = await rejectedStandings(t, organizationId, items);
  return items.map((i) => {
    const a = assessments.find((x) => x.id === i.hopeAssessmentId);
    const standing = standings.get(i.hopeAssessmentId);
    return {
      id: i.id,
      assessmentId: i.hopeAssessmentId,
      patientId: a?.patientId ?? null,
      rfaKind: (a?.rfaKind as HopeSubmissionItemView["rfaKind"]) ?? null,
      assessmentStatus: (a?.status as HopeSubmissionItemView["assessmentStatus"]) ?? null,
      status: i.itemStatus as HopeSubmissionItemStatus,
      iqiesRecordId: i.iqiesRecordId ?? null,
      processedAt: i.processedAt ? i.processedAt.toISOString() : null,
      resolution: i.itemStatus === "rejected" ? (standing?.resolution ?? "needs_correction") : null,
      correctionAssessmentId:
        i.itemStatus === "rejected" ? (standing?.correctionAssessmentId ?? null) : null,
    };
  });
}

/** The recorded CMS findings: result rows that name an edit code, an item or a message. */
export async function loadSubmissionFindings(
  t: DbClient,
  organizationId: string,
  submissionId: string,
): Promise<HopeSubmissionFindingView[]> {
  // The NEWEST rows, newest first, so that a batch past the cap (an import that settles an item is recorded whatever the count)
  // still shows its latest report, the verdict; they are put back in oldest-first order below. Only the columns the view reads:
  // the cap bounds the rows, not their bytes, so the stored `raw_result` is not pulled through the connection (its
  // `assessmentId`, which names an unmatched row, is the one field read from it).
  const newestFirst = await t
    .select({
      id: RESULT.id,
      hopeSubmissionItemId: RESULT.hopeSubmissionItemId,
      rawAssessmentId: sql<string | null>`${RESULT.rawResult}->>'assessmentId'`,
      cmsEditCode: RESULT.cmsEditCode,
      itemCode: RESULT.itemCode,
      message: RESULT.message,
      resultStatus: RESULT.resultStatus,
      cmsSeverity: RESULT.cmsSeverity,
    })
    .from(RESULT)
    .where(
      and(eq(RESULT.organizationId, organizationId), eq(RESULT.hopeSubmissionId, submissionId)),
    )
    .orderBy(desc(RESULT.createdAt), desc(RESULT.id))
    // A batch's findings are read to this many rows, the same number the import's cap names.
    .limit(MAX_RESULT_EVENTS_PER_SUBMISSION);
  const rows = newestFirst.reverse();
  const items = await t
    .select({ id: SUBITEM.id, assessmentId: SUBITEM.hopeAssessmentId })
    .from(SUBITEM)
    .where(
      and(eq(SUBITEM.organizationId, organizationId), eq(SUBITEM.hopeSubmissionId, submissionId)),
    );
  // One lookup for the whole read, not a scan of the items per row.
  const assessmentOfItem = new Map(items.map((i) => [i.id, i.assessmentId]));
  return rows
    .filter((r) => r.cmsEditCode || r.itemCode || r.message)
    .map((r) => ({
      id: r.id,
      // The matched item's assessment, else the id the report named, but only when it IS an id (a uuid, read as Postgres reads
      // one): what an operator typed into an unmatched row is not returned to every `hope.submission.read` caller.
      assessmentId:
        (r.hopeSubmissionItemId ? assessmentOfItem.get(r.hopeSubmissionItemId) : undefined) ??
        (typeof r.rawAssessmentId === "string"
          ? canonicalUuidOrNull(r.rawAssessmentId.trim())
          : null),
      severity: findingSeverity(r),
      code: r.cmsEditCode ?? null,
      itemCode: r.itemCode ?? null,
      message: r.message ?? null,
    }));
}
