import { type DbClient, schema } from "@wardenx/db";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@wardenx/types";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { HopeIsc } from "./hope-spec-registry";

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
}

export interface HopeWorkspaceItem extends HopeAssessmentItemState {
  readonly label: string;
  readonly section: string;
  readonly kind: "assessment";
  readonly options: readonly { valueCode: string; label: string; sortOrder: number }[];
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
      { field: itemCode, code: "HOPE_ITEM_INACTIVE_FOR_ISC", message: `${itemCode} is inactive for ${isc}` },
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
    super(`HOPE item ${itemCode} is controlled by workflow and cannot be edited through the public answer API`);
    this.name = "HopeProtectedItemWriteError";
  }
}

export class HopeDuplicateAnswerChangeError extends ValidationError {
  constructor(itemCode: string) {
    super("Duplicate HOPE answer changes are not allowed", [
      { field: itemCode, code: "HOPE_DUPLICATE_ANSWER_CHANGE", message: `${itemCode} appears more than once` },
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

const PROTECTED_PUBLIC_ITEMS = new Set(["A0050", "A0250", "Z0350", "Z0500B"]);
const DATE_TYPE_HINTS = ["date", "dt", "dte"];
const NUMERIC_TYPE_HINTS = ["int", "num", "dec", "numeric", "integer", "decimal"];

function asDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function isDateCode(item: SpecItemRow): boolean {
  const type = item.cmsItemTypeCode.toLowerCase();
  const code = item.itemCode.toUpperCase();
  return (
    DATE_TYPE_HINTS.some((hint) => type.includes(hint)) ||
    (/[A-Z]\d{4}[A-Z]?$/.test(code) && code.endsWith("0"))
  );
}

function normalizeSectionLabel(item: SpecItemRow): string {
  return item.sectionLabel.trim() || item.itemCode.slice(0, 1);
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
  if (options.length > 0) {
    if (typeof inputValue !== "string") {
      throw new HopeInvalidAnswerValueError(item.itemCode, "coded HOPE values must be strings");
    }
    if (inputValue === "^") {
      throw new HopeInvalidAnswerValueError(item.itemCode, "CMS ^ is represented as skipped + null, not as a normal answer value");
    }
    if (!options.some((option) => option.valueCode === inputValue)) {
      throw new HopeInvalidAnswerValueError(item.itemCode, `${inputValue} is not an allowed CMS value`);
    }
    return inputValue;
  }
  const type = item.cmsItemTypeCode.toLowerCase();
  if (isDateCode(item)) {
    if (typeof inputValue !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(inputValue)) {
      throw new HopeInvalidAnswerValueError(item.itemCode, "date values must be YYYY-MM-DD");
    }
    return inputValue;
  }
  if (NUMERIC_TYPE_HINTS.some((hint) => type.includes(hint))) {
    if (typeof inputValue !== "number" || !Number.isFinite(inputValue)) {
      throw new HopeInvalidAnswerValueError(item.itemCode, "numeric values must be finite numbers");
    }
    return inputValue;
  }
  if (typeof inputValue !== "string" && typeof inputValue !== "number" && typeof inputValue !== "boolean") {
    throw new HopeInvalidAnswerValueError(item.itemCode, "HOPE answers must be scalar values");
  }
  return inputValue;
}

function stateOf(itemCode: string, active: boolean, answer: AnswerRow | undefined): HopeAssessmentItemState {
  return {
    itemCode,
    active,
    state: answer?.state ?? "unanswered",
    value: (answer?.value as unknown | null | undefined) ?? null,
    source: answer?.source ?? null,
    answeredAt: asDate(answer?.answeredAt ?? null),
    answeredByMembershipId: answer?.answeredByMembershipId ?? null,
  };
}

export interface HopeAssessmentAnswerService {
  getWorkspace(organizationId: string, assessmentId: string): Promise<HopeAssessmentWorkspace>;
  patchAnswers(
    organizationId: string,
    membershipId: string,
    assessmentId: string,
    input: { readonly ifVersion: number; readonly changes: readonly HopeAnswerPatchChange[] },
  ): Promise<HopeAnswerPatchResult>;
  listAnswerMap(
    organizationId: string,
    assessmentId: string,
  ): Promise<Map<string, { state: Exclude<HopeCanonicalAnswerState, "unanswered">; value: unknown | null }>>;
  setSkipped(
    organizationId: string,
    assessmentId: string,
    itemCode: string,
  ): Promise<HopeAssessmentItemState>;
}

export function createHopeAssessmentAnswerService(db: DbClient): HopeAssessmentAnswerService {
  const A = schema.hopeAssessments;
  const V = schema.hopeSpecVersions;
  const I = schema.hopeSpecItems;
  const ISC = schema.hopeSpecItemIsc;
  const O = schema.hopeSpecItemOptions;
  const ANS = schema.hopeAssessmentAnswers;

  async function loadModernAssessment(tx: DbClient, organizationId: string, assessmentId: string) {
    const [row] = await tx
      .select({ assessment: A, specCode: V.code })
      .from(A)
      .leftJoin(V, eq(V.id, A.specVersionId))
      .where(and(eq(A.id, assessmentId), eq(A.organizationId, organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("HOPE assessment", assessmentId);
    if (!row.assessment.specVersionId || !row.assessment.isc || !row.specCode) {
      throw new HopeAssessmentSpecMissingError(assessmentId);
    }
    return { ...row, isc: row.assessment.isc as HopeIsc };
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
    for (const option of rows) byItem.set(option.specItemId, [...(byItem.get(option.specItemId) ?? []), option]);
    return byItem;
  }

  async function answersForAssessment(tx: DbClient, assessmentId: string) {
    const rows = await tx.select().from(ANS).where(eq(ANS.hopeAssessmentId, assessmentId));
    return new Map(rows.map((answer) => [answer.specItemId, answer]));
  }

  async function requireWritableItem(
    tx: DbClient,
    assessment: AssessmentRow,
    isc: HopeIsc,
    itemCode: string,
    publicWrite: boolean,
  ) {
    if (publicWrite && PROTECTED_PUBLIC_ITEMS.has(itemCode)) throw new HopeProtectedItemWriteError(itemCode);
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

  return {
    async getWorkspace(organizationId, assessmentId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const loaded = await loadModernAssessment(t, organizationId, assessmentId);
        const items = await activeItems(t, loaded.assessment.specVersionId!, loaded.isc);
        const optionsByItem = await optionsForItems(t, items.map((item) => item.id));
        const answersByItem = await answersForAssessment(t, assessmentId);
        const sections = new Map<string, { label: string; items: HopeWorkspaceItem[] }>();
        for (const item of items) {
          const code = normalizeSectionLabel(item);
          const options = optionsByItem.get(item.id) ?? [];
          const base = stateOf(item.itemCode, true, answersByItem.get(item.id));
          const section = sections.get(code) ?? { label: code, items: [] };
          section.items.push({
            ...base,
            label: item.shortLabel,
            section: code,
            kind: "assessment",
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
        };
      });
    },

    async patchAnswers(organizationId, membershipId, assessmentId, input) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        if (input.changes.length === 0) {
          throw new ValidationError("At least one HOPE answer change is required", [
            { field: "changes", code: "HOPE_EMPTY_ANSWER_PATCH", message: "changes must not be empty" },
          ]);
        }
        const seen = new Set<string>();
        for (const change of input.changes) {
          if (seen.has(change.itemCode)) throw new HopeDuplicateAnswerChangeError(change.itemCode);
          seen.add(change.itemCode);
        }
        const loaded = await loadModernAssessment(t, organizationId, assessmentId);
        const assessment = loaded.assessment;
        if (assessment.status !== "draft") throw new HopeAssessmentImmutableError(assessmentId, assessment.status);
        if (assessment.version !== input.ifVersion) throw new HopeAnswerVersionConflictError(assessmentId);
        const now = new Date();
        const affectedItems: SpecItemRow[] = [];

        for (const change of input.changes) {
          const item = await requireWritableItem(t, assessment, loaded.isc, change.itemCode, true);
          affectedItems.push(item);
          if (change.action === "clear") {
            await t
              .delete(ANS)
              .where(and(eq(ANS.hopeAssessmentId, assessmentId), eq(ANS.specItemId, item.id)));
            continue;
          }
          const options = await optionList(t, item.id);
          const value = normalizeHopeAnswerValue({ item, options, inputValue: change.value });
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
              value,
              source: "user",
              answeredAt: now,
              answeredByMembershipId: membershipId,
            })
            .onConflictDoUpdate({
              target: [ANS.hopeAssessmentId, ANS.specItemId],
              set: {
                state: "answered",
                value,
                source: "user",
                answeredAt: now,
                answeredByMembershipId: membershipId,
                updatedAt: now,
              },
            });
        }

        const [updated] = await t
          .update(A)
          .set({ version: sql`${A.version} + 1`, updatedAt: now })
          .where(and(eq(A.id, assessmentId), eq(A.organizationId, organizationId), eq(A.version, input.ifVersion)))
          .returning({ version: A.version });
        if (!updated) throw new HopeAnswerVersionConflictError(assessmentId);

        const answersByItem = await answersForAssessment(t, assessmentId);
        return {
          assessmentId,
          version: updated.version,
          answers: affectedItems.map((item) => stateOf(item.itemCode, true, answersByItem.get(item.id))),
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
          .where(and(eq(ANS.hopeAssessmentId, assessmentId), eq(I.specVersionId, loaded.assessment.specVersionId!)));
        return new Map(rows.map((row) => [row.itemCode, { state: row.answer.state, value: row.answer.value as unknown | null }]));
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
            answeredAt: now,
          })
          .onConflictDoUpdate({
            target: [ANS.hopeAssessmentId, ANS.specItemId],
            set: { state: "skipped", value: null, source: "derived", answeredAt: now, updatedAt: now },
          })
          .returning();
        await t
          .update(A)
          .set({ version: sql`${A.version} + 1`, updatedAt: now })
          .where(and(eq(A.id, assessmentId), eq(A.organizationId, organizationId)));
        return stateOf(item.itemCode, true, answer);
      });
    },
  };
}
