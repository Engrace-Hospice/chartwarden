import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError } from "@wardenx/types";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { HopeIsc } from "./hope-spec-registry";
import { createHopeApplicabilityEngine } from "./spec/applicability-registry";
import type { HopeRuleFinding, HopeValidationMode } from "./spec/validation";
import { createHopeValidationEngine } from "./spec/validation-registry";

type FindingRow = typeof schema.hopeValidationFindings.$inferSelect;
type SpecItemRow = typeof schema.hopeSpecItems.$inferSelect;
type AnswerRow = typeof schema.hopeAssessmentAnswers.$inferSelect;

export interface HopeValidationFindingView {
  readonly ruleId: string;
  readonly severity: "error" | "warning";
  readonly findingKind: string | null;
  readonly section: string;
  readonly itemCode: string | null;
  readonly message: string;
  readonly details: Record<string, unknown>;
  readonly fingerprint: string | null;
  readonly evaluatedAt: string;
  readonly resolved: boolean;
  readonly resolvedAt: string | null;
}

export interface HopeValidationRunView {
  readonly assessmentId: string;
  readonly mode: HopeValidationMode;
  readonly evaluatedAt: string;
  readonly findings: readonly HopeValidationFindingView[];
}

export interface HopeValidationService {
  validateAssessment(input: {
    readonly organizationId: string;
    readonly assessmentId: string;
    readonly mode?: HopeValidationMode;
    readonly submissionDate?: string;
  }): Promise<HopeValidationRunView>;
}

export class HopeValidationFindingSitingError extends ConflictError {
  constructor(readonly assessmentId: string) {
    super(
      `HOPE assessment ${assessmentId} cannot materialize validation findings without provider/location siting`,
    );
    this.name = "HopeValidationFindingSitingError";
  }
}

function asIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function answerMapByCode(input: {
  readonly itemsById: ReadonlyMap<string, SpecItemRow>;
  readonly answersByItem: ReadonlyMap<string, AnswerRow>;
}): Map<string, { state: "answered" | "skipped"; value: unknown | null }> {
  const out = new Map<string, { state: "answered" | "skipped"; value: unknown | null }>();
  for (const [itemId, answer] of input.answersByItem) {
    const item = input.itemsById.get(itemId);
    if (item)
      out.set(item.itemCode, { state: answer.state, value: answer.value as unknown | null });
  }
  return out;
}

function toFindingView(row: FindingRow): HopeValidationFindingView {
  return {
    ruleId: row.ruleId,
    severity: row.severity,
    findingKind: row.findingKind,
    section: row.section,
    itemCode: row.itemCode,
    message: row.message,
    details: (row.details as Record<string, unknown> | null) ?? {},
    fingerprint: row.fingerprint,
    evaluatedAt: row.evaluatedAt.toISOString(),
    resolved: row.resolved,
    resolvedAt: asIso(row.resolvedAt),
  };
}

function findingToView(finding: HopeRuleFinding, evaluatedAt: Date): HopeValidationFindingView {
  return {
    ruleId: finding.ruleId,
    severity: finding.severity,
    findingKind: finding.findingKind,
    section: finding.section,
    itemCode: finding.itemCode ?? null,
    message: finding.message,
    details: finding.details ?? {},
    fingerprint: finding.fingerprint,
    evaluatedAt: evaluatedAt.toISOString(),
    resolved: false,
    resolvedAt: null,
  };
}

export function createHopeValidationService(db: DbClient): HopeValidationService {
  const A = schema.hopeAssessments;
  const V = schema.hopeSpecVersions;
  const I = schema.hopeSpecItems;
  const ISC = schema.hopeSpecItemIsc;
  const ANS = schema.hopeAssessmentAnswers;
  const F = schema.hopeValidationFindings;

  async function loadActiveItems(
    tx: DbClient,
    specVersionId: string,
    isc: HopeIsc,
  ): Promise<SpecItemRow[]> {
    const rows = await tx
      .select({ item: I })
      .from(I)
      .innerJoin(ISC, eq(ISC.specItemId, I.id))
      .where(
        and(
          eq(I.specVersionId, specVersionId),
          eq(ISC.isc, isc),
          eq(ISC.active, true),
          inArray(I.kind, ["assessment", "control"]),
        ),
      )
      .orderBy(asc(I.sectionSortOrder), asc(I.itemSortOrder));
    return rows.map((row) => row.item);
  }

  async function reconcileValidationFindings(input: {
    readonly tx: DbClient;
    readonly assessment: typeof A.$inferSelect;
    readonly specVersionId: string;
    readonly findings: readonly HopeRuleFinding[];
    readonly evaluatedAt: Date;
  }): Promise<FindingRow[]> {
    const { tx, assessment, specVersionId, findings, evaluatedAt } = input;
    if (!assessment.providerEntityId || !assessment.locationId) {
      throw new HopeValidationFindingSitingError(assessment.id);
    }
    const existing = await tx
      .select()
      .from(F)
      .where(and(eq(F.hopeAssessmentId, assessment.id), eq(F.resolved, false)));
    const byFingerprint = new Map(
      existing.flatMap((row) => (row.fingerprint ? [[row.fingerprint, row] as const] : [])),
    );
    const present = new Set(findings.map((finding) => finding.fingerprint));

    for (const row of existing) {
      if (row.fingerprint && present.has(row.fingerprint)) continue;
      await tx
        .update(F)
        .set({ resolved: true, resolvedAt: evaluatedAt, evaluatedAt })
        .where(eq(F.id, row.id));
    }

    for (const finding of findings) {
      const open = byFingerprint.get(finding.fingerprint);
      if (open) {
        await tx
          .update(F)
          .set({
            specVersionId,
            ruleId: finding.ruleId,
            severity: finding.severity,
            findingKind: finding.findingKind,
            section: finding.section,
            itemCode: finding.itemCode ?? null,
            message: finding.message,
            details: finding.details ?? {},
            evaluatedAt,
          })
          .where(eq(F.id, open.id));
        continue;
      }
      await tx.insert(F).values({
        organizationId: assessment.organizationId,
        providerEntityId: assessment.providerEntityId,
        locationId: assessment.locationId,
        hopeAssessmentId: assessment.id,
        specVersionId,
        ruleId: finding.ruleId,
        severity: finding.severity,
        findingKind: finding.findingKind,
        section: finding.section,
        itemCode: finding.itemCode ?? null,
        message: finding.message,
        details: finding.details ?? {},
        fingerprint: finding.fingerprint,
        evaluatedAt,
        resolved: false,
      });
    }

    return tx
      .select()
      .from(F)
      .where(and(eq(F.hopeAssessmentId, assessment.id), eq(F.resolved, false)));
  }

  return {
    async validateAssessment(input) {
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: "" },
        async (tx) => {
          const t = tx as unknown as DbClient;
          const [loaded] = await t
            .select({ assessment: A, specCode: V.code })
            .from(A)
            .leftJoin(V, eq(V.id, A.specVersionId))
            .where(and(eq(A.id, input.assessmentId), eq(A.organizationId, input.organizationId)))
            .limit(1);
          if (!loaded) throw new NotFoundError("HOPE assessment", input.assessmentId);
          const assessment = loaded.assessment;
          if (!assessment.specVersionId || !assessment.isc || !loaded.specCode) {
            throw new ConflictError(
              `HOPE assessment ${input.assessmentId} has no frozen spec version / ISC`,
            );
          }
          const isc = assessment.isc as HopeIsc;
          const activeItems = await loadActiveItems(t, assessment.specVersionId, isc);
          const itemsById = new Map(activeItems.map((item) => [item.id, item]));
          const answers =
            activeItems.length === 0
              ? []
              : await t
                  .select()
                  .from(ANS)
                  .where(
                    and(
                      eq(ANS.hopeAssessmentId, input.assessmentId),
                      inArray(
                        ANS.specItemId,
                        activeItems.map((item) => item.id),
                      ),
                    ),
                  );
          const answersByItem = new Map(answers.map((answer) => [answer.specItemId, answer]));
          const answerMap = answerMapByCode({ itemsById, answersByItem });
          const applicability = createHopeApplicabilityEngine(loaded.specCode).evaluate({
            isc,
            activeItemCodes: activeItems.map((item) => item.itemCode),
            answers: answerMap,
          });
          const mode = input.mode ?? "final";
          const evaluatedAt = new Date();
          const findings = createHopeValidationEngine(loaded.specCode).evaluate({
            mode,
            assessment: {
              id: assessment.id,
              rfaKind: assessment.rfaKind,
              status: assessment.status,
              targetDate: assessment.targetDate.toISOString().slice(0, 10),
              specVersionId: assessment.specVersionId,
              specVersionCode: loaded.specCode,
              isc,
              correctsAssessmentId: assessment.correctsAssessmentId ?? null,
            },
            activeItems: activeItems.map((item) => ({
              itemCode: item.itemCode,
              sectionLabel: item.sectionLabel,
              kind: item.kind,
              cmsItemTypeCode: item.cmsItemTypeCode,
            })),
            answers: answerMap,
            applicability,
            submissionDate: input.submissionDate,
          });
          if (mode === "draft") {
            return {
              assessmentId: assessment.id,
              mode,
              evaluatedAt: evaluatedAt.toISOString(),
              findings: findings.map((finding) => findingToView(finding, evaluatedAt)),
            };
          }
          const rows = await reconcileValidationFindings({
            tx: t,
            assessment,
            specVersionId: assessment.specVersionId,
            findings,
            evaluatedAt,
          });
          return {
            assessmentId: assessment.id,
            mode,
            evaluatedAt: evaluatedAt.toISOString(),
            findings: rows.map(toFindingView),
          };
        },
      );
    },
  };
}
