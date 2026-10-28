// M10 — DB reads that shape a submission batch for the manual-iQIES result screens: items with their
// assessment context, the CMS findings recorded from the Final Validation Report, and where each rejected
// assessment's correction stands. All run inside the caller's `withOrgContext` transaction (RLS-scoped).
import { type DbClient, schema } from "@chartwarden/db";
import type { HopeSubmissionItemStatus } from "@chartwarden/types";
import { asc, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import {
  MAX_CORRECTION_CHAIN,
  findingSeverity,
  resolveRejectedItem,
  terminalCorrection,
} from "./hope-submission-result";
import type { HopeSubmissionFindingView, HopeSubmissionItemView } from "./routes/service";

const SUBITEM = schema.hopeSubmissionItems;
const RESULT = schema.hopeSubmissionResultEvents;
const ASSESS = schema.hopeAssessments;
export type SubmissionItemRow = typeof SUBITEM.$inferSelect;
// Skip `iqies_validation_result` (the raw XML payload): item reads that only render the view never need it.
const { iqiesValidationResult: _heavyItem, ...LIGHT_ITEM_COLUMNS } = getTableColumns(SUBITEM);
export const LIGHT_ITEM = LIGHT_ITEM_COLUMNS;

interface Standing {
  readonly correctionAssessmentId: string | null;
  readonly resolution: ReturnType<typeof resolveRejectedItem>;
}

/** Corrections supersede (a NEW assessment row; the original is never edited). The correction's latest
 * batch item decides the standing of the rejected original. */
export async function rejectedStandings(
  t: DbClient,
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
      .where(inArray(ASSESS.correctsAssessmentId, frontier))
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
        .where(inArray(SUBITEM.hopeAssessmentId, correctionIds))
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
    .where(inArray(SUBITEM.hopeSubmissionId, [...batchIds]));
  const standings = await rejectedStandings(t, rejected);
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
  submissionId: string,
): Promise<HopeSubmissionItemView[]> {
  const items = (await t
    .select(LIGHT_ITEM)
    .from(SUBITEM)
    .where(eq(SUBITEM.hopeSubmissionId, submissionId))
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
        .where(inArray(ASSESS.id, ids))
    : [];
  const standings = await rejectedStandings(t, items);
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
  submissionId: string,
): Promise<HopeSubmissionFindingView[]> {
  const rows = await t
    .select()
    .from(RESULT)
    .where(eq(RESULT.hopeSubmissionId, submissionId))
    .orderBy(asc(RESULT.createdAt), asc(RESULT.id));
  const items = await t
    .select({ id: SUBITEM.id, assessmentId: SUBITEM.hopeAssessmentId })
    .from(SUBITEM)
    .where(eq(SUBITEM.hopeSubmissionId, submissionId));
  return rows
    .filter((r) => r.cmsEditCode || r.itemCode || r.message)
    .map((r) => {
      const raw = (r.rawResult ?? {}) as { assessmentId?: unknown };
      return {
        id: r.id,
        assessmentId:
          items.find((i) => i.id === r.hopeSubmissionItemId)?.assessmentId ??
          (typeof raw.assessmentId === "string" ? raw.assessmentId : null),
        severity: findingSeverity(r),
        code: r.cmsEditCode ?? null,
        itemCode: r.itemCode ?? null,
        message: r.message ?? null,
      };
    });
}
