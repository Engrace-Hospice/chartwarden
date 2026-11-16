import { isDeepStrictEqual } from "node:util";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@chartwarden/types";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { hopeAnswerMapByCode } from "./hope-answer-map";
import { HopeInvalidAnswerValueError, normalizeHopeAnswerValue } from "./hope-answer-value";
import { persistTouchedAnswers, reconcileWithApplicability } from "./hope-answer-writes";
import { type LockedAssessment, lockAssessmentRow, lockTriggeredSfv } from "./hope-assessment-lock";
import {
  HopeUnsupportedOfficialRecordKindError,
  deriveHopeWorkflowControlAnswers,
} from "./hope-record-initializer";
import {
  HOPE_J2051_ITEM_CODES,
  createHopeSfvService,
  deriveHopeJ2051TriggerState,
  hopeSfvDueAtFromJ2050B,
} from "./hope-sfv-service";
import type { HopeIsc } from "./hope-spec-registry";
import type {
  HopeAnswerMap,
  HopeAnswerSnapshot,
  HopeApplicabilityItemResult,
  HopeApplicabilityReason,
  HopeApplicabilityState,
} from "./spec/applicability";
import { createHopeApplicabilityEngine } from "./spec/applicability-registry";

type AssessmentRow = typeof schema.hopeAssessments.$inferSelect;
type SpecItemRow = typeof schema.hopeSpecItems.$inferSelect;
type OptionRow = typeof schema.hopeSpecItemOptions.$inferSelect;
type AnswerRow = typeof schema.hopeAssessmentAnswers.$inferSelect;

// The value validator lives in ./hope-answer-value.ts; re-exported so existing importers keep working.
export { HopeInvalidAnswerValueError, normalizeHopeAnswerValue };

export type HopeCanonicalAnswerState = "unanswered" | "answered" | "skipped";
export type HopeAnswerPatchAction = "set" | "clear";

export interface HopeAssessmentItemState {
  readonly itemCode: string;
  readonly active: boolean;
  readonly state: HopeCanonicalAnswerState;
  readonly value: unknown | null;
  readonly source: AnswerRow["source"] | null;
  readonly answeredAt: string | null;
  readonly answeredByMembershipId: string | null;
  readonly applicability: HopeApplicabilityState;
  readonly skipReason: HopeApplicabilityReason | null;
}

export interface HopeWorkspaceItem extends HopeAssessmentItemState {
  readonly label: string;
  readonly section: string;
  readonly group: string | null;
  readonly kind: "assessment";
  readonly cmsItemTypeCode: string;
  readonly maxLength: number | null;
  readonly options: readonly {
    valueCode: string;
    label: string;
    sortOrder: number;
  }[];
}

export interface HopeWorkspaceSection {
  readonly code: string;
  readonly label: string;
  readonly items: readonly HopeWorkspaceItem[];
}

export interface HopeAssessmentWorkspace {
  readonly assessment: {
    readonly id: string;
    readonly status: AssessmentRow["status"];
    readonly rfaKind: AssessmentRow["rfaKind"];
    readonly targetDate: string;
    readonly isc: HopeIsc;
    readonly specVersionId: string;
    readonly specVersion: string;
    readonly version: number;
  };
  readonly sections: readonly HopeWorkspaceSection[];
  readonly progress: {
    readonly active: number;
    readonly applicable: number;
    readonly notApplicable: number;
    readonly pending: number;
    readonly answered: number;
    readonly skipped: number;
    readonly unanswered: number;
  };
  readonly huv: HopeHuvWorkspaceState | null;
}

export interface HopeHuvWorkspaceState {
  readonly scheduleId: string | null;
  readonly scheduleStatus: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly lateDeadline: string | null;
  readonly timingState:
    | "upcoming"
    | "within_window"
    | "due_soon"
    | "late"
    | "completed"
    | "unknown";
  readonly z0350: string | null;
}

export interface HopeAnswerPatchChange {
  readonly itemCode: string;
  readonly action: HopeAnswerPatchAction;
  readonly value?: unknown;
}

export interface HopeAnswerPatchResult {
  readonly assessmentId: string;
  readonly version: number;
  readonly answers: readonly HopeAssessmentItemState[];
}

export class HopeAssessmentImmutableError extends ConflictError {
  constructor(assessmentId: string, status: string) {
    super(`HOPE assessment ${assessmentId} is ${status}; only draft assessments can be edited`);
    this.name = "HopeAssessmentImmutableError";
  }
}

export class HopeAnswerVersionConflictError extends ConflictError {
  constructor(assessmentId: string) {
    super(`HOPE assessment ${assessmentId} version is stale; reload and retry`);
    this.name = "HopeAnswerVersionConflictError";
  }
}

export class HopeItemInactiveForIscError extends ValidationError {
  constructor(itemCode: string, isc: HopeIsc) {
    super("HOPE item is inactive for this ISC", [
      {
        field: itemCode,
        code: "HOPE_ITEM_INACTIVE_FOR_ISC",
        message: `${itemCode} is inactive for ${isc}`,
      },
    ]);
    this.name = "HopeItemInactiveForIscError";
  }
}

export class HopeProtectedItemWriteError extends ForbiddenError {
  constructor(itemCode: string) {
    super(
      `HOPE item ${itemCode} is controlled by workflow and cannot be edited through the public answer API`,
    );
    this.name = "HopeProtectedItemWriteError";
  }
}

export class HopeItemNotApplicableError extends ValidationError {
  constructor(
    itemCode: string,
    applicability: HopeApplicabilityState,
    reason?: HopeApplicabilityReason,
  ) {
    super("HOPE item is not currently applicable", [
      {
        field: itemCode,
        code:
          applicability === "pending"
            ? "HOPE_ITEM_APPLICABILITY_PENDING"
            : "HOPE_ITEM_NOT_APPLICABLE",
        message: `${itemCode} is ${applicability}${reason?.ruleId ? ` by ${reason.ruleId}` : ""}`,
      },
    ]);
    this.name = "HopeItemNotApplicableError";
  }
}

export class HopeDuplicateAnswerChangeError extends ValidationError {
  constructor(itemCode: string) {
    super("Duplicate HOPE answer changes are not allowed", [
      {
        field: itemCode,
        code: "HOPE_DUPLICATE_ANSWER_CHANGE",
        message: `${itemCode} appears more than once`,
      },
    ]);
    this.name = "HopeDuplicateAnswerChangeError";
  }
}

export class HopeAssessmentSpecMissingError extends ConflictError {
  constructor(assessmentId: string) {
    super(`HOPE assessment ${assessmentId} has no frozen spec version / ISC`);
    this.name = "HopeAssessmentSpecMissingError";
  }
}

const PROTECTED_PUBLIC_ITEMS = new Set([
  "A0050",
  "A0220",
  "A0250",
  "A0270",
  "J2052A",
  "J2052B",
  "J2052C",
  "J2053A",
  "J2053B",
  "J2053C",
  "J2053D",
  "J2053E",
  "J2053F",
  "J2053G",
  "J2053H",
  "Z0350",
  "Z0500B",
]);
const J2051_TRIGGER_INPUT_ITEMS = new Set<string>(["J2050A", "J2050B", ...HOPE_J2051_ITEM_CODES]);
const RFA_REASON_VALUES: Partial<Record<AssessmentRow["rfaKind"], string>> = {
  "01_admission": "1",
  "02_huv1": "2",
  "03_huv2": "3",
  "05_discharge": "9",
};

function asDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizeSectionLabel(item: SpecItemRow): string {
  return item.sectionLabel.trim() || item.itemCode.slice(0, 1);
}

function workspaceGroupForItem(itemCode: string): string | null {
  if (itemCode === "J0050") return "Current status";
  if (itemCode.startsWith("J090") || itemCode.startsWith("J091")) return "Pain";
  if (itemCode.startsWith("J203") || itemCode.startsWith("J204")) return "Shortness of breath";
  if (itemCode.startsWith("J2050") || itemCode.startsWith("J2051")) return "Symptom impact";
  if (itemCode.startsWith("J2052") || itemCode.startsWith("J2053"))
    return "Symptom Follow-Up Visit";
  return null;
}

/**
 * The workflow-control answers (A0050, A0250) a record of this RFA kind carries, or `null` for the one kind that has none
 * (an RFA-04 SFV completion is not an official CMS record kind). ONLY that refusal is the "no controls" answer; any other
 * failure is a defect and reaches the caller instead of reading as "this record needs no control answers".
 */
export function workflowControlAnswers(
  assessment: Pick<AssessmentRow, "rfaKind" | "isc" | "correctsAssessmentId">,
) {
  try {
    return deriveHopeWorkflowControlAnswers({
      rfaKind: assessment.rfaKind,
      isc: assessment.isc as HopeIsc | null,
      correctsAssessmentId: assessment.correctsAssessmentId ?? null,
    });
  } catch (error) {
    if (error instanceof HopeUnsupportedOfficialRecordKindError) return null;
    throw error;
  }
}

const DEFAULT_APPLICABILITY: HopeApplicabilityItemResult = {
  active: true,
  applicability: "applicable",
};

function stateOf(
  itemCode: string,
  active: boolean,
  answer: AnswerRow | undefined,
  applicability: HopeApplicabilityItemResult = DEFAULT_APPLICABILITY,
): HopeAssessmentItemState {
  return {
    itemCode,
    active,
    state: answer?.state ?? "unanswered",
    value: (answer?.value as unknown | null | undefined) ?? null,
    source: answer?.source ?? null,
    answeredAt: asDate(answer?.answeredAt ?? null),
    answeredByMembershipId: answer?.answeredByMembershipId ?? null,
    applicability: applicability.applicability,
    skipReason: applicability.reason ?? null,
  };
}

function j2051Projection(answers: HopeAnswerMap): {
  triggerFired: boolean;
  maxSeverity: "none" | "mild" | "moderate" | "severe";
} {
  const trigger = deriveHopeJ2051TriggerState(answers);
  return {
    triggerFired: trigger.triggerFired,
    maxSeverity: trigger.maxSeverity,
  };
}

/** A patch must name at least one change, and no item twice. */
function assertPatchShape(changes: readonly HopeAnswerPatchChange[]): void {
  if (changes.length === 0) {
    throw new ValidationError("At least one HOPE answer change is required", [
      {
        field: "changes",
        code: "HOPE_EMPTY_ANSWER_PATCH",
        message: "changes must not be empty",
      },
    ]);
  }
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.itemCode)) throw new HopeDuplicateAnswerChangeError(change.itemCode);
    seen.add(change.itemCode);
  }
}

/** A change whose item and value were validated against the frozen spec. */
type PreparedChange =
  | { readonly itemCode: string; readonly action: "clear" }
  | { readonly itemCode: string; readonly action: "set"; readonly value: unknown };

/** Every item a `set` names must be applicable under the proposed answers. */
function assertSetItemsApplicable(
  changes: readonly PreparedChange[],
  applicability: { readonly items: ReadonlyMap<string, HopeApplicabilityItemResult> },
): void {
  for (const change of changes) {
    if (change.action !== "set") continue;
    const itemState = applicability.items.get(change.itemCode);
    if (!itemState || itemState.applicability !== "applicable") {
      throw new HopeItemNotApplicableError(
        change.itemCode,
        itemState?.applicability ?? "not_applicable",
        itemState?.reason,
      );
    }
  }
}

export interface HopeAssessmentAnswerService {
  /**
   * `options.mayWrite` (REQUIRED, no default): whether the caller holds `hope.timepoint.write`. A draft's out-of-date workflow
   * control answers are rewritten on open (a write under no actor) only for a caller who may write; any other caller is shown
   * those controls derived in memory from the assessment row (their item states and the progress counts that follow), and
   * nothing is stored. A reader's view equals a writer's only for the workflow-control items (A0050, A0250) and the progress counts derived from them; the chart refresh and the workflow-control reconcile are done for a writer only, so a reader sees chart-derived answers as stored and the workflow controls derived on the fly, and a draft that needs a chart refresh reads differently for a reader until a writer opens it.
   */
  getWorkspace(
    organizationId: string,
    assessmentId: string,
    options: { readonly mayWrite: boolean },
  ): Promise<HopeAssessmentWorkspace>;
  patchAnswers(
    organizationId: string,
    membershipId: string,
    assessmentId: string,
    input: {
      readonly ifVersion: number;
      readonly changes: readonly HopeAnswerPatchChange[];
    },
  ): Promise<HopeAnswerPatchResult>;
  listAnswerMap(
    organizationId: string,
    assessmentId: string,
  ): Promise<
    Map<
      string,
      {
        state: Exclude<HopeCanonicalAnswerState, "unanswered">;
        value: unknown | null;
      }
    >
  >;
  setSkipped(
    organizationId: string,
    assessmentId: string,
    itemCode: string,
  ): Promise<HopeAssessmentItemState>;
  setWorkflowAnswer(
    tx: DbClient,
    input: {
      readonly organizationId: string;
      readonly membershipId: string | null;
      readonly assessment: AssessmentRow;
      readonly itemCode: string;
      readonly value: unknown;
      readonly sourceReference: Record<string, unknown>;
      readonly at: Date;
    },
  ): Promise<HopeAssessmentItemState>;
}

/**
 * Side-effect hooks the answer service fires inside the patch transaction. The route service binds
 * `onSfvOpened` to its transactional outbox so `m10.hope.sfv_created` (M36's SFV-obligation alert,
 * M14) lands in the SAME tx that inserted/reopened the `symptom_follow_up_visit` row — the SFV
 * obligation is now opened when the J2050/J2051 answers are patched, not at sign.
 */
export interface HopeAnswerServiceHooks {
  onSfvOpened?(
    tx: DbClient,
    event: {
      readonly organizationId: string;
      readonly sfvId: string;
      readonly triggeringAssessmentId: string;
      readonly dueAt: string;
    },
  ): Promise<void>;
}

export function createHopeAssessmentAnswerService(
  db: DbClient,
  hooks: HopeAnswerServiceHooks = {},
): HopeAssessmentAnswerService {
  const A = schema.hopeAssessments;
  const V = schema.hopeSpecVersions;
  const I = schema.hopeSpecItems;
  const ISC = schema.hopeSpecItemIsc;
  const O = schema.hopeSpecItemOptions;
  const ANS = schema.hopeAssessmentAnswers;
  const SCHED = schema.hopeTimepointSchedules;
  const sfvService = createHopeSfvService();

  async function loadModernAssessment(tx: DbClient, organizationId: string, assessmentId: string) {
    const [row] = await tx
      .select({ assessment: A, specCode: V.code })
      .from(A)
      .leftJoin(V, eq(V.id, A.specVersionId))
      .where(and(eq(A.id, assessmentId), eq(A.organizationId, organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("HOPE assessment", assessmentId);
    const specCode = row.specCode;
    if (!row.assessment.specVersionId || !row.assessment.isc || !specCode) {
      throw new HopeAssessmentSpecMissingError(assessmentId);
    }
    return { ...row, specCode, isc: row.assessment.isc as HopeIsc };
  }

  async function activeItems(
    tx: DbClient,
    specVersionId: string,
    isc: HopeIsc,
    kinds: readonly SpecItemRow["kind"][] = ["assessment"],
  ) {
    const rows = await tx
      .select({ item: I })
      .from(I)
      .innerJoin(ISC, eq(ISC.specItemId, I.id))
      .where(
        and(
          eq(I.specVersionId, specVersionId),
          eq(ISC.isc, isc),
          eq(ISC.active, true),
          inArray(I.kind, [...kinds]),
        ),
      )
      .orderBy(asc(I.sectionSortOrder), asc(I.itemSortOrder));
    return rows.map((row) => row.item);
  }

  async function optionsForItems(tx: DbClient, itemIds: readonly string[]) {
    if (itemIds.length === 0) return new Map<string, OptionRow[]>();
    const rows = await tx
      .select()
      .from(O)
      .where(inArray(O.specItemId, [...itemIds]))
      .orderBy(asc(O.specItemId), asc(O.sortOrder));
    const byItem = new Map<string, OptionRow[]>();
    for (const option of rows)
      byItem.set(option.specItemId, [...(byItem.get(option.specItemId) ?? []), option]);
    return byItem;
  }

  async function answersForAssessment(tx: DbClient, assessmentId: string) {
    const rows = await tx.select().from(ANS).where(eq(ANS.hopeAssessmentId, assessmentId));
    return new Map(rows.map((answer) => [answer.specItemId, answer]));
  }

  /** The row fields the control-answer reconcile reads. */
  type ControlAssessment = Pick<
    LockedAssessment,
    | "id"
    | "status"
    | "rfaKind"
    | "isc"
    | "correctsAssessmentId"
    | "specVersionId"
    | "organizationId"
    | "providerEntityId"
    | "locationId"
  >;

  /** The workflow-control answers this draft should carry and does not carry yet (a read; takes no lock). */
  async function outOfDateControls(
    tx: DbClient,
    assessment: ControlAssessment,
    itemsByCode: ReadonlyMap<string, SpecItemRow>,
  ) {
    if (assessment.status !== "draft" || !assessment.specVersionId) return [];
    const controls = workflowControlAnswers(assessment);
    if (!controls) return [];
    const answers = await answersForAssessment(tx, assessment.id);
    return controls.flatMap((control) => {
      const item = itemsByCode.get(control.itemCode);
      if (!item) return [];
      const current = answers.get(item.id);
      const inPlace =
        current?.state === "answered" && isDeepStrictEqual(current.value, control.value);
      return inPlace ? [] : [{ item, value: control.value }];
    });
  }

  /**
   * Write the control answers `outOfDateControls` finds. Called on the LOCKED row: what is out of date is worked out
   * again here, because a concurrent open may have written them since the unlocked check, and a control already in place
   * is left alone (rewriting it only churns the PHI audit trail).
   */
  async function reconcileWorkflowControlAnswers(
    tx: DbClient,
    assessment: ControlAssessment,
    itemsByCode: ReadonlyMap<string, SpecItemRow>,
  ) {
    const now = new Date();
    for (const { item, value } of await outOfDateControls(tx, assessment, itemsByCode)) {
      await tx
        .insert(ANS)
        .values({
          organizationId: assessment.organizationId,
          providerEntityId: assessment.providerEntityId,
          locationId: assessment.locationId,
          hopeAssessmentId: assessment.id,
          specVersionId: assessment.specVersionId!,
          specItemId: item.id,
          state: "answered",
          value,
          source: "derived",
          sourceReference: { reason: "workflow_control_reconciled" },
          answeredAt: now,
        })
        .onConflictDoUpdate({
          target: [ANS.hopeAssessmentId, ANS.specItemId],
          set: {
            state: "answered",
            value,
            source: "derived",
            sourceReference: { reason: "workflow_control_reconciled" },
            answeredAt: now,
            answeredByMembershipId: null,
            updatedAt: now,
          },
        });
    }
  }

  /**
   * Two phases, as the admission prefill does: an unlocked read finds whether any control answer is out of date (the
   * common case after the first open: none), and only then is the assessment row taken (M10's lock order: before the
   * first answer write) and the reconcile run on the locked row. Status is judged again on that row.
   */
  async function reconcileControlsWhenNeeded(
    tx: DbClient,
    organizationId: string,
    assessment: ControlAssessment,
    itemsByCode: ReadonlyMap<string, SpecItemRow>,
  ): Promise<void> {
    if ((await outOfDateControls(tx, assessment, itemsByCode)).length === 0) return;
    const locked = await lockAssessmentRow(tx, organizationId, assessment.id);
    if (locked?.status === "draft") await reconcileWorkflowControlAnswers(tx, locked, itemsByCode);
  }

  async function requireWritableItem(
    tx: DbClient,
    assessment: AssessmentRow,
    isc: HopeIsc,
    itemCode: string,
    publicWrite: boolean,
  ) {
    if (publicWrite && PROTECTED_PUBLIC_ITEMS.has(itemCode))
      throw new HopeProtectedItemWriteError(itemCode);
    const [row] = await tx
      .select({ item: I, active: ISC.active })
      .from(I)
      .innerJoin(ISC, eq(ISC.specItemId, I.id))
      .where(
        and(
          eq(I.specVersionId, assessment.specVersionId!),
          eq(I.itemCode, itemCode),
          eq(ISC.isc, isc),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError("HOPE spec item", itemCode);
    if (!row.active) throw new HopeItemInactiveForIscError(itemCode, isc);
    return row.item;
  }

  async function optionList(tx: DbClient, specItemId: string) {
    return tx.select().from(O).where(eq(O.specItemId, specItemId)).orderBy(asc(O.sortOrder));
  }

  async function setWorkflowAnswerInTx(
    tx: DbClient,
    input: {
      readonly organizationId: string;
      readonly membershipId: string | null;
      readonly assessment: AssessmentRow;
      readonly itemCode: string;
      readonly value: unknown;
      readonly sourceReference: Record<string, unknown>;
      readonly at: Date;
    },
  ): Promise<HopeAssessmentItemState> {
    if (!input.assessment.specVersionId || !input.assessment.isc)
      throw new HopeAssessmentSpecMissingError(input.assessment.id);
    if (input.assessment.status !== "draft")
      throw new HopeAssessmentImmutableError(input.assessment.id, input.assessment.status);
    const item = await requireWritableItem(
      tx,
      input.assessment,
      input.assessment.isc as HopeIsc,
      input.itemCode,
      false,
    );
    const options = await optionList(tx, item.id);
    const value = normalizeHopeAnswerValue({
      item,
      options,
      inputValue: input.value,
    });
    const [answer] = await tx
      .insert(ANS)
      .values({
        organizationId: input.organizationId,
        providerEntityId: input.assessment.providerEntityId,
        locationId: input.assessment.locationId,
        hopeAssessmentId: input.assessment.id,
        specVersionId: input.assessment.specVersionId,
        specItemId: item.id,
        state: "answered",
        value,
        source: "derived",
        sourceReference: input.sourceReference,
        answeredAt: input.at,
        answeredByMembershipId: input.membershipId,
      })
      .onConflictDoUpdate({
        target: [ANS.hopeAssessmentId, ANS.specItemId],
        set: {
          state: "answered",
          value,
          source: "derived",
          sourceReference: input.sourceReference,
          answeredAt: input.at,
          answeredByMembershipId: input.membershipId,
          updatedAt: input.at,
        },
      })
      .returning();
    return stateOf(item.itemCode, true, answer);
  }

  function timingState(input: {
    readonly schedule: typeof SCHED.$inferSelect | undefined;
    readonly assessmentStatus: AssessmentRow["status"];
    readonly z0350: string | null;
  }): HopeHuvWorkspaceState["timingState"] {
    if (!input.schedule) return "unknown";
    if (input.assessmentStatus === "signed" || input.z0350) return "completed";
    const now = Date.now();
    const opens = input.schedule.windowOpensAt.getTime();
    const closes = input.schedule.windowClosesAt.getTime();
    if (now < opens) return "upcoming";
    if (now <= closes) {
      const daysLeft = Math.ceil((closes - now) / 86_400_000);
      return daysLeft <= 3 ? "due_soon" : "within_window";
    }
    return "late";
  }

  async function huvWorkspaceState(
    tx: DbClient,
    assessment: AssessmentRow,
    input: {
      readonly itemsById: ReadonlyMap<string, SpecItemRow>;
      readonly answersByItem: ReadonlyMap<string, AnswerRow>;
    },
  ) {
    if (assessment.isc !== "HUV") return null;
    const [schedule] = await tx
      .select()
      .from(SCHED)
      .where(
        assessment.scheduleId
          ? eq(SCHED.id, assessment.scheduleId)
          : and(
              eq(SCHED.admissionId, assessment.admissionId),
              eq(SCHED.rfaKind, assessment.rfaKind),
            ),
      )
      .limit(1);
    let z0350: string | null = null;
    for (const [itemId, answer] of input.answersByItem) {
      if (input.itemsById.get(itemId)?.itemCode !== "Z0350") continue;
      z0350 = typeof answer.value === "string" ? answer.value : null;
      break;
    }
    return {
      scheduleId: schedule?.id ?? assessment.scheduleId ?? null,
      scheduleStatus: schedule?.status ?? null,
      windowStart: schedule?.windowOpensAt.toISOString() ?? null,
      windowEnd: schedule?.windowClosesAt.toISOString() ?? null,
      lateDeadline: schedule?.lateDeadlineAt.toISOString() ?? null,
      timingState: timingState({
        schedule,
        assessmentStatus: assessment.status,
        z0350,
      }),
      z0350,
    };
  }

  /**
   * Validate every requested change against the frozen spec BEFORE any lock is taken: a protected or unknown item, a value
   * that is not allowed for its item. None of it depends on the record's mutable state, so a bad request is refused
   * without ever queueing behind another writer (a patch that cannot succeed must not hold up, or wait for, a valid one).
   */
  async function prepareChanges(
    tx: DbClient,
    assessment: Pick<AssessmentRow, "specVersionId">,
    isc: HopeIsc,
    changes: readonly HopeAnswerPatchChange[],
    itemsByCode: ReadonlyMap<string, SpecItemRow>,
  ): Promise<PreparedChange[]> {
    const prepared: PreparedChange[] = [];
    for (const change of changes) {
      const item = itemsByCode.get(change.itemCode);
      if (PROTECTED_PUBLIC_ITEMS.has(change.itemCode))
        throw new HopeProtectedItemWriteError(change.itemCode);
      if (!item) {
        await requireWritableItem(tx, assessment as AssessmentRow, isc, change.itemCode, true);
        throw new NotFoundError("HOPE spec item", change.itemCode);
      }
      if (change.action === "clear") {
        prepared.push({ itemCode: change.itemCode, action: "clear" });
        continue;
      }
      const value = normalizeHopeAnswerValue({
        item,
        options: await optionList(tx, item.id),
        inputValue: change.value,
      });
      prepared.push({ itemCode: change.itemCode, action: "set", value });
    }
    return prepared;
  }

  /**
   * The assessment row, locked, and judged AGAIN: a writer that committed since the unlocked read (another patch, a heal,
   * a sign) is only visible on the locked row. The version bump at the end of the patch then updates a row this
   * transaction already holds.
   */
  async function lockDraftAtVersion(
    tx: DbClient,
    organizationId: string,
    assessmentId: string,
    ifVersion: number,
  ): Promise<LockedAssessment> {
    const locked = await lockAssessmentRow(tx, organizationId, assessmentId);
    if (!locked) throw new NotFoundError("HOPE assessment", assessmentId);
    if (locked.status !== "draft")
      throw new HopeAssessmentImmutableError(assessmentId, locked.status);
    if (locked.version !== ifVersion) throw new HopeAnswerVersionConflictError(assessmentId);
    return locked;
  }

  return {
    async getWorkspace(organizationId, assessmentId, options) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const loaded = await loadModernAssessment(t, organizationId, assessmentId);
        const items = await activeItems(t, loaded.assessment.specVersionId!, loaded.isc);
        const itemsByCode = new Map(items.map((item) => [item.itemCode, item]));
        // The control answers are written only for a DRAFT, only when one is out of date (see the function), and only for a
        // caller who may write. A reader gets those controls derived below, in memory, with no stored copy. A reader's view equals a writer's only for the workflow-control items (A0050, A0250) and the progress counts derived from them; the chart refresh and the workflow-control reconcile are done for a writer only, so a reader sees chart-derived answers as stored and the workflow controls derived on the fly, and a draft that needs a chart refresh reads differently for a reader until a writer opens it.
        if (options.mayWrite)
          await reconcileControlsWhenNeeded(t, organizationId, loaded.assessment, itemsByCode);
        const itemsById = new Map(items.map((item) => [item.id, item]));
        const optionsByItem = await optionsForItems(
          t,
          items.map((item) => item.id),
        );
        const answersByItem = await answersForAssessment(t, assessmentId);

        const canonicalAnswersByItem = new Map(answersByItem);
        const controls = workflowControlAnswers(loaded.assessment);
        // The workflow controls this record should carry, as answer rows, by item id: what a writer's open would have stored.
        const derivedControls = new Map<string, AnswerRow>();

        if (controls) {
          for (const control of controls) {
            const item = itemsByCode.get(control.itemCode);

            if (!item) continue;

            const derived = {
              ...(answersByItem.get(item.id) ?? {}),
              organizationId: loaded.assessment.organizationId,
              providerEntityId: loaded.assessment.providerEntityId,
              locationId: loaded.assessment.locationId,
              hopeAssessmentId: loaded.assessment.id,
              specVersionId: loaded.assessment.specVersionId!,
              specItemId: item.id,
              state: "answered",
              value: control.value,
              source: "derived",
              sourceReference: {
                reason: "workflow_control",
              },
              answeredAt: new Date(),
              answeredByMembershipId: null,
            } as AnswerRow;
            derivedControls.set(item.id, derived);
            canonicalAnswersByItem.set(item.id, derived);
          }
        }
        // What the response shows. A writer's open has just reconciled (a draft), so its stored answers ARE the controls. A reader's
        // open stores nothing, so a draft's out-of-date control answers (never opened by a writer) are shown as the derived ones: the
        // item states, the progress counts and the HUV state then equal a writer's. A control already in place keeps its stored row
        // (and its own timestamp); a signed or inactivated record is shown as stored, as a writer's open shows it.
        const inPlace = (stored: AnswerRow | undefined, derived: AnswerRow): boolean =>
          stored?.state === "answered" && isDeepStrictEqual(stored.value, derived.value);
        const displayAnswersByItem =
          options.mayWrite || loaded.assessment.status !== "draft"
            ? answersByItem
            : new Map([
                ...answersByItem,
                ...[...derivedControls].filter(
                  ([id, derived]) => !inPlace(answersByItem.get(id), derived),
                ),
              ]);

        const applicability = createHopeApplicabilityEngine(loaded.specCode).evaluate({
          isc: loaded.isc,
          activeItemCodes: items.map((item) => item.itemCode),
          answers: hopeAnswerMapByCode({ itemsById, answersByItem: canonicalAnswersByItem }),
        });
        const sections = new Map<string, { label: string; items: HopeWorkspaceItem[] }>();
        const progress = {
          active: items.length,
          applicable: 0,
          notApplicable: 0,
          pending: 0,
          answered: 0,
          skipped: 0,
          unanswered: 0,
        };
        for (const item of items) {
          const code = normalizeSectionLabel(item);
          const options = optionsByItem.get(item.id) ?? [];
          const base = stateOf(
            item.itemCode,
            true,
            displayAnswersByItem.get(item.id),
            applicability.items.get(item.itemCode),
          );
          if (base.applicability === "applicable") progress.applicable += 1;
          if (base.applicability === "not_applicable") progress.notApplicable += 1;
          if (base.applicability === "pending") progress.pending += 1;
          if (base.state === "answered") progress.answered += 1;
          if (base.state === "skipped") progress.skipped += 1;
          if (base.state === "unanswered") progress.unanswered += 1;
          const section = sections.get(code) ?? { label: code, items: [] };
          section.items.push({
            ...base,
            label: item.shortLabel,
            section: code,
            group: workspaceGroupForItem(item.itemCode),
            kind: "assessment",
            cmsItemTypeCode: item.cmsItemTypeCode,
            maxLength: item.fixedRecordLength,
            options: options.map((option) => ({
              valueCode: option.valueCode,
              label: option.label,
              sortOrder: option.sortOrder,
            })),
          });
          sections.set(code, section);
        }
        return {
          assessment: {
            id: loaded.assessment.id,
            status: loaded.assessment.status,
            rfaKind: loaded.assessment.rfaKind,
            targetDate: loaded.assessment.targetDate.toISOString(),
            isc: loaded.isc,
            specVersionId: loaded.assessment.specVersionId!,
            specVersion: loaded.specCode,
            version: loaded.assessment.version,
          },
          sections: [...sections.entries()].map(([code, section]) => ({
            code,
            label: section.label,
            items: section.items,
          })),
          progress,
          huv: await huvWorkspaceState(t, loaded.assessment, {
            itemsById,
            answersByItem: displayAnswersByItem,
          }),
        };
      });
    },

    async patchAnswers(organizationId, membershipId, assessmentId, input) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        assertPatchShape(input.changes);
        const loaded = await loadModernAssessment(t, organizationId, assessmentId);
        if (loaded.assessment.status !== "draft")
          throw new HopeAssessmentImmutableError(assessmentId, loaded.assessment.status);
        if (loaded.assessment.version !== input.ifVersion)
          throw new HopeAnswerVersionConflictError(assessmentId);
        const items = await activeItems(t, loaded.assessment.specVersionId!, loaded.isc);
        const itemsByCode = new Map(items.map((item) => [item.itemCode, item]));
        // A request that can never succeed is refused before it takes (or waits for) any lock.
        const prepared = await prepareChanges(
          t,
          loaded.assessment,
          loaded.isc,
          input.changes,
          itemsByCode,
        );
        await lockTriggeredSfv(t, organizationId, loaded.assessment, loaded.isc); // before any answer write
        // From here on the LOCKED row is the record: status, version and the siting columns below come from it, not from
        // the unlocked read above, which a writer that committed in between may have made stale.
        const assessment = await lockDraftAtVersion(
          t,
          organizationId,
          assessmentId,
          input.ifVersion,
        );
        const now = new Date();
        const itemsById = new Map(items.map((item) => [item.id, item]));
        const proposedAnswers = hopeAnswerMapByCode({
          itemsById,
          answersByItem: await answersForAssessment(t, assessmentId),
        });
        for (const change of prepared) {
          if (change.action === "clear") proposedAnswers.delete(change.itemCode);
          else proposedAnswers.set(change.itemCode, { state: "answered", value: change.value });
        }
        const applicability = createHopeApplicabilityEngine(loaded.specCode).evaluate({
          isc: loaded.isc,
          activeItemCodes: items.map((item) => item.itemCode),
          answers: proposedAnswers,
        });
        assertSetItemsApplicable(prepared, applicability);
        const { answers: reconciledAnswers, touched } = reconcileWithApplicability(
          proposedAnswers,
          applicability,
          new Set(prepared.map((change) => change.itemCode)),
        );
        await persistTouchedAnswers({
          tx: t,
          assessment,
          membershipId,
          itemsByCode,
          touched,
          answers: reconciledAnswers,
          applicability,
          now,
        });

        const projection = [...touched].some((itemCode) => J2051_TRIGGER_INPUT_ITEMS.has(itemCode))
          ? j2051Projection(reconciledAnswers)
          : null;
        if (projection) {
          const reconciled = await sfvService.reconcileTriggeringAssessment({
            tx: t,
            organizationId,
            assessment,
            isc: loaded.isc,
            answers: reconciledAnswers,
            now,
          });
          // A newly opened (or re-opened after withdrawal) SFV obligation is the fact M36 alerts on.
          if (
            (reconciled.action === "created" || reconciled.action === "reopened") &&
            reconciled.sfvId &&
            reconciled.trigger.symptomImpactDate
          ) {
            await hooks.onSfvOpened?.(t, {
              organizationId,
              sfvId: reconciled.sfvId,
              triggeringAssessmentId: assessment.id,
              dueAt: hopeSfvDueAtFromJ2050B(reconciled.trigger.symptomImpactDate).toISOString(),
            });
          }
        }
        const assessmentUpdate = projection
          ? {
              version: sql`${A.version} + 1`,
              updatedAt: now,
              j2051TriggerFired: projection.triggerFired,
              j2051MaxSeverity: projection.maxSeverity,
            }
          : { version: sql`${A.version} + 1`, updatedAt: now };
        const [updated] = await t
          .update(A)
          .set(assessmentUpdate)
          .where(
            and(
              eq(A.id, assessmentId),
              eq(A.organizationId, organizationId),
              eq(A.version, input.ifVersion),
            ),
          )
          .returning({ version: A.version });
        if (!updated) throw new HopeAnswerVersionConflictError(assessmentId);

        const answersByItem = await answersForAssessment(t, assessmentId);
        return {
          assessmentId,
          version: updated.version,
          answers: [...touched].flatMap((itemCode) => {
            const item = itemsByCode.get(itemCode);
            if (!item) return [];
            return [
              stateOf(
                item.itemCode,
                true,
                answersByItem.get(item.id),
                applicability.items.get(item.itemCode),
              ),
            ];
          }),
        };
      });
    },

    async listAnswerMap(organizationId, assessmentId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const loaded = await loadModernAssessment(t, organizationId, assessmentId);
        const rows = await t
          .select({ itemCode: I.itemCode, answer: ANS })
          .from(ANS)
          .innerJoin(I, eq(I.id, ANS.specItemId))
          .where(
            and(
              eq(ANS.hopeAssessmentId, assessmentId),
              eq(I.specVersionId, loaded.assessment.specVersionId!),
            ),
          );
        return new Map(
          rows.map((row) => [
            row.itemCode,
            {
              state: row.answer.state,
              value: row.answer.value as unknown | null,
            },
          ]),
        );
      });
    },

    async setSkipped(organizationId, assessmentId, itemCode) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const loaded = await loadModernAssessment(t, organizationId, assessmentId);
        if (loaded.assessment.status !== "draft") {
          throw new HopeAssessmentImmutableError(assessmentId, loaded.assessment.status);
        }
        // The assessment row BEFORE the answer write (it is UPDATEd at the end), judged again on the locked row.
        const locked = await lockAssessmentRow(t, organizationId, assessmentId);
        if (locked?.status !== "draft") {
          throw new HopeAssessmentImmutableError(assessmentId, locked?.status ?? "missing");
        }
        const item = await requireWritableItem(t, loaded.assessment, loaded.isc, itemCode, false);
        const now = new Date();
        const [answer] = await t
          .insert(ANS)
          .values({
            organizationId,
            providerEntityId: loaded.assessment.providerEntityId,
            locationId: loaded.assessment.locationId,
            hopeAssessmentId: assessmentId,
            specVersionId: loaded.assessment.specVersionId!,
            specItemId: item.id,
            state: "skipped",
            value: null,
            source: "derived",
            sourceReference: { reason: "skip_pattern", ruleId: "internal" },
            answeredAt: now,
          })
          .onConflictDoUpdate({
            target: [ANS.hopeAssessmentId, ANS.specItemId],
            set: {
              state: "skipped",
              value: null,
              source: "derived",
              sourceReference: { reason: "skip_pattern", ruleId: "internal" },
              answeredAt: now,
              answeredByMembershipId: null,
              updatedAt: now,
            },
          })
          .returning();
        await t
          .update(A)
          .set({ version: sql`${A.version} + 1`, updatedAt: now })
          .where(and(eq(A.id, assessmentId), eq(A.organizationId, organizationId)));
        return stateOf(item.itemCode, true, answer);
      });
    },
    setWorkflowAnswer: setWorkflowAnswerInTx,
  };
}
