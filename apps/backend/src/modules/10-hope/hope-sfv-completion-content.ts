// apps/backend/src/modules/10-hope/hope-sfv-completion-content.ts — the J2052/J2053 CONTENT guard of an SFV
// completion: which spec's option set judges the values, whether each value is allowed, and the refusal text.
// Split out of `hope-sfv-completion-guards.ts` (the lookup/binding guards) so each stays small. The answer writer
// (`hope-sfv-completion-answers.ts`) judges the same way before it writes anything.
import { type DbClient, schema } from "@chartwarden/db";
import { HopeStateError } from "@chartwarden/hope";
import { NotFoundError } from "@chartwarden/types";
import { and, desc, eq, inArray } from "drizzle-orm";
import { HopeInvalidAnswerValueError, normalizeHopeAnswerValue } from "./hope-answer-service";
import { idForLog } from "./hope-log-id";
import {
  type CompletedSfvRegulatoryAnswerPlan,
  HOPE_J2053_ITEM_CODES,
  SFV_COMPLETION_INCOMPLETE_MESSAGE,
  buildCompletedSfvRegulatoryAnswerPlan,
} from "./hope-sfv-completion-plan";
import {
  type HopeIsc,
  HopeSpecNotFoundForTargetDateError,
  logSpecNotInForce,
  specVersionEffectiveOn,
} from "./hope-spec-registry";

const ASSESS = schema.hopeAssessments;
const SFV = schema.symptomFollowUpVisits;
const ITEM = schema.hopeSpecItems;
const OPTION = schema.hopeSpecItemOptions;
const SPEC_VERSION = schema.hopeSpecVersions;

type SfvRow = typeof SFV.$inferSelect;
type SpecItemRow = typeof ITEM.$inferSelect;
type OptionRow = typeof OPTION.$inferSelect;

/** The regulatory items an RFA-04 completion writes onto its triggering assessment (J2052A-C, J2053A-H). */
const SFV_REGULATORY_ITEM_CODES: readonly string[] = [
  "J2052A",
  "J2052B",
  "J2052C",
  ...HOPE_J2053_ITEM_CODES,
];

export interface SfvRegulatoryItem {
  readonly item: SpecItemRow;
  readonly options: readonly OptionRow[];
}

/** The frozen spec version + ISC of a triggering assessment: what decides which CMS codes are allowed. */
interface SfvSpecScope {
  readonly specVersionId: string;
  readonly isc: HopeIsc;
}

/** The regulatory items (with their allowed values) a completion writes, active for the spec version + ISC. */
export async function loadSfvRegulatoryItems(
  tx: DbClient,
  scope: SfvSpecScope,
): Promise<ReadonlyMap<string, SfvRegulatoryItem>> {
  const rows = await tx
    .select({ item: ITEM })
    .from(ITEM)
    .innerJoin(schema.hopeSpecItemIsc, eq(schema.hopeSpecItemIsc.specItemId, ITEM.id))
    .where(
      and(
        eq(ITEM.specVersionId, scope.specVersionId),
        inArray(ITEM.itemCode, [...SFV_REGULATORY_ITEM_CODES]),
        eq(schema.hopeSpecItemIsc.isc, scope.isc),
        eq(schema.hopeSpecItemIsc.active, true),
      ),
    );
  const options =
    rows.length === 0
      ? []
      : await tx
          .select()
          .from(OPTION)
          .where(
            inArray(
              OPTION.specItemId,
              rows.map((row) => row.item.id),
            ),
          );
  return new Map(
    rows.map(({ item }) => [
      item.itemCode,
      { item, options: options.filter((option) => option.specItemId === item.id) },
    ]),
  );
}

/**
 * The item codes in `plan` whose value the CMS spec does not allow, judged by the SAME validator the answer
 * engine applies to a clinician's own answer (`normalizeHopeAnswerValue`: coded values must be an option,
 * the skip-pattern caret is refused, dates must be dates). An item the spec does not carry active for the
 * ISC is not written, so it is not judged either.
 */
export function invalidSfvRegulatoryItemCodes(
  plan: CompletedSfvRegulatoryAnswerPlan,
  items: ReadonlyMap<string, SfvRegulatoryItem>,
): string[] {
  const invalid: string[] = [];
  for (const [itemCode, value] of plan.answered) {
    const entry = items.get(itemCode);
    if (!entry) continue;
    try {
      normalizeHopeAnswerValue({ item: entry.item, options: entry.options, inputValue: value });
    } catch (error) {
      if (!(error instanceof HopeInvalidAnswerValueError)) throw error;
      invalid.push(itemCode);
    }
  }
  return invalid;
}

/** PHI-free refusal text: item codes only, never the submitted values. */
export function sfvCompletionInvalidMessage(itemCodes: readonly string[]): string {
  return `An SFV completion needs an allowed CMS code for every follow-up item; not allowed: ${itemCodes.join(", ")}. None was closed and nothing was written.`;
}

/**
 * The spec version a triggering assessment WITHOUT a frozen spec is judged against: the newest one IN FORCE on `onDate`
 * (started on or before it, not retired before it: a future-dated or retired version is never chosen) that carries the
 * J2053 follow-up items active for an admission (HA) assessment, or `null` when the database holds no such spec.
 * Versions that started the same day are ordered by creation time, then id, so the pick is deterministic.
 * An SFV can only be triggered by an HA admission assessment (J2053 is not active for any other ISC), so HA is the
 * ISC whose option set applies to a legacy row that never had its spec frozen.
 */
async function newestHaSpecScope(tx: DbClient, onDate: string): Promise<SfvSpecScope | null> {
  const [row] = await tx
    .select({ specVersionId: ITEM.specVersionId })
    .from(ITEM)
    .innerJoin(schema.hopeSpecItemIsc, eq(schema.hopeSpecItemIsc.specItemId, ITEM.id))
    .innerJoin(SPEC_VERSION, eq(SPEC_VERSION.id, ITEM.specVersionId))
    .where(
      and(
        eq(ITEM.itemCode, HOPE_J2053_ITEM_CODES[0]),
        eq(schema.hopeSpecItemIsc.isc, "HA"),
        eq(schema.hopeSpecItemIsc.active, true),
        specVersionEffectiveOn(onDate),
      ),
    )
    .orderBy(desc(SPEC_VERSION.effectiveFrom), desc(SPEC_VERSION.createdAt), desc(SPEC_VERSION.id))
    .limit(1);
  return row ? { specVersionId: row.specVersionId, isc: "HA" } : null;
}

/**
 * The completion's J2052/J2053 content must be complete AND carry CMS-allowed values, checked BEFORE the
 * signed RFA-04 is inserted. The allowed values come from the TRIGGERING assessment's frozen spec version + ISC
 * (the assessment the answers are written onto). A legacy triggering assessment whose spec was never frozen is
 * judged against the newest HA spec in force on ITS OWN target date: the date `ensureDraftSpecInitialized` freezes the
 * spec by later, so a value this check accepts is one the freeze then accepts too (judging by the server's date instead
 * would, at a spec boundary, accept values the review self-heal then refuses). When no HA spec is in force on that date
 * there is nothing to judge against, and the completion is refused (`HopeSpecNotFoundForTargetDateError`) rather than
 * recorded unchecked: the stored RFA-04 payload would otherwise be written later, as derived answers, by the heal.
 */
export async function requireValidSfvCompletionContent(
  tx: DbClient,
  organizationId: string,
  sfv: SfvRow,
  completion: {
    readonly completedDate: string;
    readonly data: Record<string, unknown>;
  },
): Promise<CompletedSfvRegulatoryAnswerPlan> {
  const plan = buildCompletedSfvRegulatoryAnswerPlan(completion.completedDate, completion.data);
  if (!plan)
    throw new HopeStateError("M10_SFV_COMPLETION_INCOMPLETE", SFV_COMPLETION_INCOMPLETE_MESSAGE);
  const [triggering] = await tx
    .select({
      specVersionId: ASSESS.specVersionId,
      isc: ASSESS.isc,
      targetDate: ASSESS.targetDate,
    })
    .from(ASSESS)
    .where(
      and(eq(ASSESS.id, sfv.triggeringAssessmentId), eq(ASSESS.organizationId, organizationId)),
    )
    .limit(1);
  // The SFV row points at it by foreign key, so a miss is a broken reference, never a reason to judge by the server's date.
  if (!triggering) throw new NotFoundError("HOPE assessment", sfv.triggeringAssessmentId);
  // The refusal is a 4xx the error handler logs at info with only its code: this line names the org and the assessment.
  const scope = await logSpecNotInForce(
    `the triggering assessment ${idForLog(sfv.triggeringAssessmentId)} of an SFV completion (org ${idForLog(organizationId)})`,
    () => specScopeOf(tx, triggering),
  );
  const invalid = invalidSfvRegulatoryItemCodes(plan, await loadSfvRegulatoryItems(tx, scope));
  if (invalid.length > 0) {
    throw new HopeStateError("M10_SFV_COMPLETION_INCOMPLETE", sfvCompletionInvalidMessage(invalid));
  }
  return plan;
}

/**
 * The spec scope the completion is judged against: the frozen one, else the newest HA spec in force on the target date.
 * A target date on which a spec is in force but none carries the J2053 follow-up items active for HA reads as "not in
 * force" too (`newestHaSpecScope` finds nothing): the remedy is the same, an administrator loads a spec that covers it.
 */
async function specScopeOf(
  tx: DbClient,
  triggering: {
    readonly specVersionId: string | null;
    readonly isc: string | null;
    readonly targetDate: Date;
  },
): Promise<SfvSpecScope> {
  if (triggering.specVersionId && triggering.isc) {
    return { specVersionId: triggering.specVersionId, isc: triggering.isc as HopeIsc };
  }
  // The registry's own reading of a target date (its UTC calendar day), so this and the later freeze agree.
  const onDate = triggering.targetDate.toISOString().slice(0, 10);
  const scope = await newestHaSpecScope(tx, onDate);
  if (!scope) throw new HopeSpecNotFoundForTargetDateError(onDate);
  return scope;
}
