import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@wardenx/types";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { deriveHopeWorkflowControlAnswers } from "./hope-record-initializer";
import {
  HOPE_J2051_ITEM_CODES,
  createHopeSfvService,
  deriveHopeJ2051TriggerState,
  hopeSfvDueAtFromJ2050B,
} from "./hope-sfv-service";
import type { HopeIsc } from "./hope-spec-registry";
import type {
  HopeAnswerMap,
  HopeApplicabilityItemResult,
  HopeApplicabilityReason,
  HopeApplicabilityState,
} from "./spec/applicability";
import { createHopeApplicabilityEngine } from "./spec/applicability-registry";

type AssessmentRow = typeof schema.hopeAssessments.$inferSelect;
type SpecItemRow = typeof schema.hopeSpecItems.$inferSelect;
type OptionRow = typeof schema.hopeSpecItemOptions.$inferSelect;
type AnswerRow = typeof schema.hopeAssessmentAnswers.$inferSelect;

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

export class HopeInvalidAnswerValueError extends ValidationError {
  constructor(itemCode: string, message: string) {
    super("Invalid HOPE answer value", [
      { field: itemCode, code: "HOPE_INVALID_ANSWER_VALUE", message },
    ]);
    this.name = "HopeInvalidAnswerValueError";
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
const DATE_TYPE_HINTS = ["date", "dt", "dte"];
const NUMERIC_TYPE_HINTS = ["int", "num", "dec", "numeric", "integer", "decimal"];
const DATE_FORMAT_PLACEHOLDERS = new Set(["YYYYMMDD", "YYYYMM", "YYYY"]);
const RFA_REASON_VALUES: Partial<Record<AssessmentRow["rfaKind"], string>> = {
  "01_admission": "1",
  "02_huv1": "2",
  "03_huv2": "3",
  "05_discharge": "9",
};

function asDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isDateCode(item: SpecItemRow): boolean {
  const type = item.cmsItemTypeCode.toLowerCase();
  return DATE_TYPE_HINTS.some((hint) => type.includes(hint));
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

function workflowControlAnswers(assessment: AssessmentRow) {
  try {
    return deriveHopeWorkflowControlAnswers({
      rfaKind: assessment.rfaKind,
      isc: assessment.isc as HopeIsc | null,
      correctsAssessmentId: assessment.correctsAssessmentId ?? null,
    });
  } catch {
    return null;
  }
}

export function normalizeHopeAnswerValue(input: {
  readonly item: SpecItemRow;
  readonly options: readonly OptionRow[];
  readonly inputValue: unknown;
}): unknown {
  const { item, options, inputValue } = input;
  if (inputValue == null) {
    throw new HopeInvalidAnswerValueError(item.itemCode, "answered values cannot be null");
  }
  const hasDatePlaceholder = options.some((option) => option.valueCode === "YYYYMMDD");
  if (hasDatePlaceholder || isDateCode(item)) {
    if (typeof inputValue !== "string") {
      throw new HopeInvalidAnswerValueError(item.itemCode, "date values must be YYYY-MM-DD");
    }
    if (DATE_FORMAT_PLACEHOLDERS.has(inputValue)) return inputValue;
    if (/^\d{8}$/.test(inputValue)) {
      return `${inputValue.slice(0, 4)}-${inputValue.slice(4, 6)}-${inputValue.slice(6, 8)}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inputValue)) {
      throw new HopeInvalidAnswerValueError(item.itemCode, "date values must be YYYY-MM-DD");
    }
    return inputValue;
  }
  const acceptsFreeText = options.some((option) => option.valueCode === "Text");
  if (acceptsFreeText) {
    if (typeof inputValue !== "string") {
      throw new HopeInvalidAnswerValueError(item.itemCode, "text HOPE values must be strings");
    }
    if (inputValue === "^") {
      throw new HopeInvalidAnswerValueError(
        item.itemCode,
        "CMS ^ is represented as skipped + null, not as a normal answer value",
      );
    }
    if (item.fixedRecordLength && inputValue.length > item.fixedRecordLength) {
      throw new HopeInvalidAnswerValueError(
        item.itemCode,
        `text values must not exceed ${item.fixedRecordLength} characters`,
      );
    }
    return inputValue;
  }
  if (options.length > 0) {
    if (typeof inputValue !== "string") {
      throw new HopeInvalidAnswerValueError(item.itemCode, "coded HOPE values must be strings");
    }
    if (inputValue === "^") {
      throw new HopeInvalidAnswerValueError(
        item.itemCode,
        "CMS ^ is represented as skipped + null, not as a normal answer value",
      );
    }
    if (!options.some((option) => option.valueCode === inputValue)) {
      throw new HopeInvalidAnswerValueError(
        item.itemCode,
        `${inputValue} is not an allowed CMS value`,
      );
    }
    return inputValue;
  }
  const type = item.cmsItemTypeCode.toLowerCase();
  if (NUMERIC_TYPE_HINTS.some((hint) => type.includes(hint))) {
    if (typeof inputValue !== "number" || !Number.isFinite(inputValue)) {
      throw new HopeInvalidAnswerValueError(item.itemCode, "numeric values must be finite numbers");
    }
    return inputValue;
  }
  if (
    typeof inputValue !== "string" &&
    typeof inputValue !== "number" &&
    typeof inputValue !== "boolean"
  ) {
    throw new HopeInvalidAnswerValueError(item.itemCode, "HOPE answers must be scalar values");
  }
  return inputValue;
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

function answerMapByCode(input: {
  readonly itemsById: ReadonlyMap<string, SpecItemRow>;
  readonly answersByItem: ReadonlyMap<string, AnswerRow>;
}): Map<string, { state: "answered" | "skipped"; value: unknown | null }> {
  const out = new Map<string, { state: "answered" | "skipped"; value: unknown | null }>();
  for (const [itemId, answer] of input.answersByItem) {
    const item = input.itemsById.get(itemId);
    if (item)
      out.set(item.itemCode, {
        state: answer.state,
        value: answer.value as unknown | null,
      });
  }
  return out;
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

export interface HopeAssessmentAnswerService {
  getWorkspace(organizationId: string, assessmentId: string): Promise<HopeAssessmentWorkspace>;
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

  async function reconcileWorkflowControlAnswers(
    tx: DbClient,
    assessment: AssessmentRow,
    itemsByCode: ReadonlyMap<string, SpecItemRow>,
  ) {
    if (assessment.status !== "draft" || !assessment.specVersionId) return;
    const controls = workflowControlAnswers(assessment);
    if (!controls) return;
    const now = new Date();
    for (const control of controls) {
      const item = itemsByCode.get(control.itemCode);
      if (!item) continue;
      await tx
        .insert(ANS)
        .values({
          organizationId: assessment.organizationId,
          providerEntityId: assessment.providerEntityId,
          locationId: assessment.locationId,
          hopeAssessmentId: assessment.id,
          specVersionId: assessment.specVersionId,
          specItemId: item.id,
          state: "answered",
          value: control.value,
          source: "derived",
          sourceReference: { reason: "workflow_control_reconciled" },
          answeredAt: now,
        })
        .onConflictDoUpdate({
          target: [ANS.hopeAssessmentId, ANS.specItemId],
          set: {
            state: "answered",
            value: control.value,
            source: "derived",
            sourceReference: { reason: "workflow_control_reconciled" },
            answeredAt: now,
            answeredByMembershipId: null,
            updatedAt: now,
          },
        });
    }
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

  return {
    async getWorkspace(organizationId, assessmentId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const loaded = await loadModernAssessment(t, organizationId, assessmentId);
        const items = await activeItems(t, loaded.assessment.specVersionId!, loaded.isc);
        const itemsByCode = new Map(items.map((item) => [item.itemCode, item]));
        await reconcileWorkflowControlAnswers(t, loaded.assessment, itemsByCode);
        const itemsById = new Map(items.map((item) => [item.id, item]));
        const optionsByItem = await optionsForItems(
          t,
          items.map((item) => item.id),
        );
        const answersByItem = await answersForAssessment(t, assessmentId);

        const canonicalAnswersByItem = new Map(answersByItem);

        const controls = workflowControlAnswers(loaded.assessment);

        if (controls) {
          for (const control of controls) {
            const item = itemsByCode.get(control.itemCode);

            if (!item) continue;

            canonicalAnswersByItem.set(item.id, {
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
            } as AnswerRow);
          }
        }

        const applicability = createHopeApplicabilityEngine(loaded.specCode).evaluate({
          isc: loaded.isc,
          activeItemCodes: items.map((item) => item.itemCode),
          answers: answerMapByCode({ itemsById, answersByItem: canonicalAnswersByItem }),
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
            answersByItem.get(item.id),
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
            answersByItem,
          }),
        };
      });
    },

    async patchAnswers(organizationId, membershipId, assessmentId, input) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        if (input.changes.length === 0) {
          throw new ValidationError("At least one HOPE answer change is required", [
            {
              field: "changes",
              code: "HOPE_EMPTY_ANSWER_PATCH",
              message: "changes must not be empty",
            },
          ]);
        }
        const seen = new Set<string>();
        for (const change of input.changes) {
          if (seen.has(change.itemCode)) throw new HopeDuplicateAnswerChangeError(change.itemCode);
          seen.add(change.itemCode);
        }
        const loaded = await loadModernAssessment(t, organizationId, assessmentId);
        const assessment = loaded.assessment;
        if (assessment.status !== "draft")
          throw new HopeAssessmentImmutableError(assessmentId, assessment.status);
        if (assessment.version !== input.ifVersion)
          throw new HopeAnswerVersionConflictError(assessmentId);
        const now = new Date();
        const items = await activeItems(t, assessment.specVersionId!, loaded.isc);
        const itemsByCode = new Map(items.map((item) => [item.itemCode, item]));
        const itemsById = new Map(items.map((item) => [item.id, item]));
        const currentAnswersByItem = await answersForAssessment(t, assessmentId);
        const proposedAnswers = answerMapByCode({
          itemsById,
          answersByItem: currentAnswersByItem,
        });
        const touched = new Set<string>();

        for (const change of input.changes) {
          const item = itemsByCode.get(change.itemCode);
          if (PROTECTED_PUBLIC_ITEMS.has(change.itemCode))
            throw new HopeProtectedItemWriteError(change.itemCode);
          if (!item) {
            await requireWritableItem(t, assessment, loaded.isc, change.itemCode, true);
            throw new NotFoundError("HOPE spec item", change.itemCode);
          }
          touched.add(change.itemCode);
          if (change.action === "clear") {
            proposedAnswers.delete(change.itemCode);
            continue;
          }
          const options = await optionList(t, item.id);
          const value = normalizeHopeAnswerValue({
            item,
            options,
            inputValue: change.value,
          });
          proposedAnswers.set(change.itemCode, { state: "answered", value });
        }

        const engine = createHopeApplicabilityEngine(loaded.specCode);
        const applicability = engine.evaluate({
          isc: loaded.isc,
          activeItemCodes: items.map((item) => item.itemCode),
          answers: proposedAnswers,
        });

        for (const change of input.changes) {
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

        const reconciledAnswers = new Map(proposedAnswers);
        for (const [itemCode, itemState] of applicability.items) {
          if (itemState.applicability === "applicable") {
            const proposed = reconciledAnswers.get(itemCode);
            if (proposed?.state === "skipped") {
              reconciledAnswers.delete(itemCode);
              touched.add(itemCode);
            }
            continue;
          }
          if (itemState.applicability === "not_applicable") {
            reconciledAnswers.set(itemCode, { state: "skipped", value: null });
            touched.add(itemCode);
            continue;
          }
          if (reconciledAnswers.has(itemCode)) {
            reconciledAnswers.delete(itemCode);
            touched.add(itemCode);
          }
        }

        for (const itemCode of touched) {
          const item = itemsByCode.get(itemCode);
          if (!item) continue;
          const answer = reconciledAnswers.get(itemCode);
          if (!answer) {
            await t
              .delete(ANS)
              .where(and(eq(ANS.hopeAssessmentId, assessmentId), eq(ANS.specItemId, item.id)));
            continue;
          }
          if (answer.state === "skipped") {
            const reason = applicability.items.get(itemCode)?.reason;
            await t
              .insert(ANS)
              .values({
                organizationId,
                providerEntityId: assessment.providerEntityId,
                locationId: assessment.locationId,
                hopeAssessmentId: assessmentId,
                specVersionId: assessment.specVersionId!,
                specItemId: item.id,
                state: "skipped",
                value: null,
                source: "derived",
                sourceReference: reason
                  ? { reason: "skip_pattern", ...reason }
                  : { reason: "skip_pattern" },
                answeredAt: now,
              })
              .onConflictDoUpdate({
                target: [ANS.hopeAssessmentId, ANS.specItemId],
                set: {
                  state: "skipped",
                  value: null,
                  source: "derived",
                  sourceReference: reason
                    ? { reason: "skip_pattern", ...reason }
                    : { reason: "skip_pattern" },
                  answeredAt: now,
                  answeredByMembershipId: null,
                  updatedAt: now,
                },
              });
            continue;
          }
          await t
            .insert(ANS)
            .values({
              organizationId,
              providerEntityId: assessment.providerEntityId,
              locationId: assessment.locationId,
              hopeAssessmentId: assessmentId,
              specVersionId: assessment.specVersionId!,
              specItemId: item.id,
              state: "answered",
              value: answer.value,
              source: "user",
              answeredAt: now,
              answeredByMembershipId: membershipId,
            })
            .onConflictDoUpdate({
              target: [ANS.hopeAssessmentId, ANS.specItemId],
              set: {
                state: "answered",
                value: answer.value,
                source: "user",
                sourceReference: null,
                answeredAt: now,
                answeredByMembershipId: membershipId,
                updatedAt: now,
              },
            });
        }

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
