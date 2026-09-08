import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, ValidationError } from "@wardenx/types";
import { and, asc, eq, inArray } from "drizzle-orm";
import { deriveHopeJ2051TriggerState } from "./hope-sfv-service";
import type { HopeIsc } from "./hope-spec-registry";
import type { HopeApplicabilityResult } from "./spec/applicability";
import { createHopeApplicabilityEngine } from "./spec/applicability-registry";
import type { HopeRuleFinding } from "./spec/validation";
import { createHopeValidationEngine } from "./spec/validation-registry";

type AssessmentRow = typeof schema.hopeAssessments.$inferSelect;
type SpecItemRow = typeof schema.hopeSpecItems.$inferSelect;
type AnswerRow = typeof schema.hopeAssessmentAnswers.$inferSelect;
type SfvRow = typeof schema.symptomFollowUpVisits.$inferSelect;
type MutableSectionReview = {
  code: string;
  active: number;
  applicable: number;
  answered: number;
  skipped: number;
  pending: number;
  unanswered: number;
  errors: number;
  warnings: number;
};

export interface HopeReadinessBlocker {
  readonly code: string;
  readonly section?: string;
  readonly itemCode?: string;
  readonly ruleId?: string;
  readonly message: string;
}

export interface HopeSectionReview {
  readonly code: string;
  readonly active: number;
  readonly applicable: number;
  readonly answered: number;
  readonly skipped: number;
  readonly pending: number;
  readonly unanswered: number;
  readonly errors: number;
  readonly warnings: number;
  readonly state: "complete" | "needs_attention" | "blocked";
}

export interface HopeReviewReadModel {
  readonly assessmentId: string;
  readonly version: number;
  readonly specVersion: string;
  readonly isc: HopeIsc;
  readonly status: AssessmentRow["status"];
  readonly signedAt: string | null;
  readonly signedByMembershipId: string | null;
  readonly z0350: string | null;
  readonly z0500b: string | null;
  readonly sections: readonly HopeSectionReview[];
  readonly progress: {
    readonly active: number;
    readonly applicable: number;
    readonly answered: number;
    readonly skipped: number;
    readonly pending: number;
    readonly unanswered: number;
  };
  readonly validation: {
    readonly errorCount: number;
    readonly warningCount: number;
    readonly hasBlockingErrors: boolean;
    readonly findings: readonly {
      readonly ruleId: string;
      readonly severity: "error" | "warning";
      readonly section: string;
      readonly itemCode: string | null;
      readonly message: string;
    }[];
  };
  readonly sfv: {
    readonly required: boolean | null;
    readonly status?: string;
    readonly dueAt?: string;
    readonly completedAt?: string | null;
  };
  readonly readiness: {
    readonly readyToSign: boolean;
    readonly blockers: readonly HopeReadinessBlocker[];
  };
}

export class HopeAssessmentNotReadyToSignError extends ValidationError {
  constructor(readonly review: HopeReviewReadModel) {
    super(
      "HOPE assessment is not ready to sign",
      review.readiness.blockers.map((blocker) => ({
        field: blocker.itemCode ?? blocker.section ?? "assessment",
        code: blocker.code,
        message: blocker.message,
      })),
    );
    this.name = "HopeAssessmentNotReadyToSignError";
  }
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function sectionOf(item: SpecItemRow): string {
  return item.sectionLabel.trim() || item.itemCode.slice(0, 1);
}

function answerMapByCode(input: {
  readonly itemsById: ReadonlyMap<string, SpecItemRow>;
  readonly answersByItem: ReadonlyMap<string, AnswerRow>;
  readonly candidateAnswers?: ReadonlyMap<
    string,
    { state: "answered" | "skipped"; value: unknown | null }
  >;
}) {
  const out = new Map<string, { state: "answered" | "skipped"; value: unknown | null }>();
  for (const [itemId, answer] of input.answersByItem) {
    const item = input.itemsById.get(itemId);
    if (item)
      out.set(item.itemCode, { state: answer.state, value: answer.value as unknown | null });
  }
  for (const [itemCode, answer] of input.candidateAnswers ?? []) out.set(itemCode, answer);
  return out;
}

export interface HopeReadinessCandidate {
  readonly assessment: AssessmentRow;
  readonly specVersionCode: string;
  readonly isc: HopeIsc;
  readonly candidateZ0500B?: string;
}

export interface HopeAssessmentReadinessService {
  getReview(input: {
    readonly organizationId: string;
    readonly assessmentId: string;
    readonly candidateZ0500B?: string;
  }): Promise<HopeReviewReadModel>;
  evaluateCandidateInTx(tx: DbClient, input: HopeReadinessCandidate): Promise<HopeReviewReadModel>;
}

export function createHopeAssessmentReadinessService(db: DbClient): HopeAssessmentReadinessService {
  const A = schema.hopeAssessments;
  const V = schema.hopeSpecVersions;
  const I = schema.hopeSpecItems;
  const ISC = schema.hopeSpecItemIsc;
  const ANS = schema.hopeAssessmentAnswers;
  const SFV = schema.symptomFollowUpVisits;

  async function loadItems(tx: DbClient, specVersionId: string, isc: HopeIsc) {
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

  function findingsForFinalCandidate(input: {
    readonly assessment: AssessmentRow;
    readonly specCode: string;
    readonly isc: HopeIsc;
    readonly items: readonly SpecItemRow[];
    readonly answers: Map<string, { state: "answered" | "skipped"; value: unknown | null }>;
    readonly applicability: HopeApplicabilityResult;
  }): readonly HopeRuleFinding[] {
    return createHopeValidationEngine(input.specCode).evaluate({
      mode: "final",
      assessment: {
        id: input.assessment.id,
        rfaKind: input.assessment.rfaKind,
        status: input.assessment.status,
        targetDate: input.assessment.targetDate.toISOString().slice(0, 10),
        specVersionId: input.assessment.specVersionId!,
        specVersionCode: input.specCode,
        isc: input.isc,
        correctsAssessmentId: input.assessment.correctsAssessmentId ?? null,
      },
      activeItems: input.items.map((item) => ({
        itemCode: item.itemCode,
        sectionLabel: item.sectionLabel,
        kind: item.kind,
        cmsItemTypeCode: item.cmsItemTypeCode,
      })),
      answers: input.answers,
      applicability: input.applicability,
    });
  }

  function blockersFor(input: {
    readonly items: readonly SpecItemRow[];
    readonly answers: Map<string, { state: "answered" | "skipped"; value: unknown | null }>;
    readonly applicability: HopeApplicabilityResult;
    readonly findings: readonly HopeRuleFinding[];
    readonly sfv: SfvRow | undefined;
  }): HopeReadinessBlocker[] {
    const blockers: HopeReadinessBlocker[] = [];
    const seen = new Set<string>();
    const push = (blocker: HopeReadinessBlocker) => {
      const key = `${blocker.code}:${blocker.itemCode ?? ""}:${blocker.ruleId ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      blockers.push(blocker);
    };
    for (const item of input.items.filter((row) => row.kind === "assessment")) {
      const app = input.applicability.items.get(item.itemCode)?.applicability ?? "applicable";
      const answer = input.answers.get(item.itemCode);
      if (app === "pending") {
        push({
          code: "PENDING_APPLICABILITY",
          section: sectionOf(item),
          itemCode: item.itemCode,
          message: `${item.itemCode} cannot be finalized until its applicability branch is resolved.`,
        });
      } else if (app === "applicable" && answer?.state !== "answered") {
        push({
          code: "UNANSWERED_APPLICABLE_ITEM",
          section: sectionOf(item),
          itemCode: item.itemCode,
          message: `${item.itemCode} is active and applicable but unanswered.`,
        });
      } else if (app === "not_applicable" && answer?.state !== "skipped") {
        push({
          code: "SKIP_STATE_UNRESOLVED",
          section: sectionOf(item),
          itemCode: item.itemCode,
          message: `${item.itemCode} is not applicable but has not been reconciled to skipped.`,
        });
      }
    }
    for (const finding of input.findings) {
      if (finding.severity !== "error") continue;
      push({
        code: "VALIDATION_ERROR",
        section: finding.section,
        itemCode: finding.itemCode ?? undefined,
        ruleId: finding.ruleId,
        message: finding.message,
      });
    }
    const trigger = deriveHopeJ2051TriggerState(input.answers);
    if (trigger.state === "pending") {
      push({
        code: "PENDING_APPLICABILITY",
        section: "J",
        itemCode: "J2051A",
        message: "J2051 symptom impact branch is incomplete.",
      });
    }
    if (trigger.state === "true") {
      const j2052a = input.answers.get("J2052A");
      const completedRegulatory = j2052a?.state === "answered" && j2052a.value === "1";
      if (!input.sfv) {
        push({
          code: "SFV_REQUIRED_OPEN",
          section: "J",
          itemCode: "J2052A",
          message: "SFV is required but no operational SFV obligation exists.",
        });
      } else if (
        (input.sfv.status === "open" || input.sfv.status === "overdue") &&
        completedRegulatory
      ) {
        push({
          code: "RECORD_STATE_INCONSISTENT",
          section: "J",
          itemCode: "J2052A",
          message:
            "Regulatory SFV completion is answered but the operational SFV task is still open.",
        });
      } else if (input.sfv.status === "completed" && !completedRegulatory) {
        push({
          code: "SFV_REGULATORY_STATE_INCOMPLETE",
          section: "J",
          itemCode: "J2052A",
          message:
            "Operational SFV is completed but regulatory J2052/J2053 answers are incomplete.",
        });
      } else if (input.sfv.status !== "completed" && !completedRegulatory) {
        push({
          code: "SFV_REQUIRED_OPEN",
          section: "J",
          itemCode: "J2052A",
          message: "Required SFV branch is unresolved.",
        });
      }
    }
    const needsCompletionDate =
      input.items.some((item) => item.itemCode === "Z0350") &&
      input.answers.get("Z0350")?.state !== "answered";
    if (needsCompletionDate) {
      push({
        code: "HUV_COMPLETION_DATE_REQUIRED",
        section: "Z",
        itemCode: "Z0350",
        message: "Assessment completion date is required.",
      });
    }
    return blockers;
  }

  async function evaluateCandidateInTx(
    tx: DbClient,
    input: HopeReadinessCandidate,
  ): Promise<HopeReviewReadModel> {
    const items = await loadItems(tx, input.assessment.specVersionId!, input.isc);
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const answers = await tx
      .select()
      .from(ANS)
      .where(
        and(
          eq(ANS.hopeAssessmentId, input.assessment.id),
          inArray(
            ANS.specItemId,
            items.map((item) => item.id),
          ),
        ),
      );
    const candidateAnswers = new Map<
      string,
      { state: "answered" | "skipped"; value: unknown | null }
    >();
    if (input.candidateZ0500B)
      candidateAnswers.set("Z0500B", { state: "answered", value: input.candidateZ0500B });
    const answerMap = answerMapByCode({
      itemsById,
      answersByItem: new Map(answers.map((answer) => [answer.specItemId, answer])),
      candidateAnswers,
    });
    const applicability = createHopeApplicabilityEngine(input.specVersionCode).evaluate({
      isc: input.isc,
      activeItemCodes: items
        .filter((item) => item.kind === "assessment")
        .map((item) => item.itemCode),
      answers: answerMap,
    });
    const findings = findingsForFinalCandidate({
      assessment: input.assessment,
      specCode: input.specVersionCode,
      isc: input.isc,
      items,
      answers: answerMap,
      applicability,
    });
    const [sfv] = await tx
      .select()
      .from(SFV)
      .where(
        and(
          eq(SFV.organizationId, input.assessment.organizationId),
          eq(SFV.triggeringAssessmentId, input.assessment.id),
        ),
      )
      .limit(1);
    const validation = {
      errorCount: findings.filter((finding) => finding.severity === "error").length,
      warningCount: findings.filter((finding) => finding.severity === "warning").length,
      hasBlockingErrors: findings.some((finding) => finding.severity === "error"),
      findings: findings.map((finding) => ({
        ruleId: finding.ruleId,
        severity: finding.severity,
        section: finding.section,
        itemCode: finding.itemCode ?? null,
        message: finding.message,
      })),
    };
    const bySection = new Map<string, MutableSectionReview>();
    const progress = {
      active: 0,
      applicable: 0,
      answered: 0,
      skipped: 0,
      pending: 0,
      unanswered: 0,
    };
    for (const item of items.filter((row) => row.kind === "assessment")) {
      const section = sectionOf(item);
      const app = applicability.items.get(item.itemCode)?.applicability ?? "applicable";
      const answer = answerMap.get(item.itemCode);
      const current = bySection.get(section) ?? {
        code: section,
        active: 0,
        applicable: 0,
        answered: 0,
        skipped: 0,
        pending: 0,
        unanswered: 0,
        errors: 0,
        warnings: 0,
      };
      progress.active += 1;
      current.active += 1;
      if (app === "pending") {
        progress.pending += 1;
        current.pending += 1;
      } else if (app === "not_applicable") {
        if (answer?.state === "skipped") {
          progress.skipped += 1;
          current.skipped += 1;
        } else {
          progress.unanswered += 1;
          current.unanswered += 1;
        }
      } else {
        progress.applicable += 1;
        current.applicable += 1;
        if (answer?.state === "answered") {
          progress.answered += 1;
          current.answered += 1;
        } else {
          progress.unanswered += 1;
          current.unanswered += 1;
        }
      }
      bySection.set(section, current);
    }
    for (const finding of findings) {
      const section = bySection.get(finding.section);
      if (!section) continue;
      if (finding.severity === "error") section.errors += 1;
      else section.warnings += 1;
    }
    const blockers = blockersFor({ items, answers: answerMap, applicability, findings, sfv });
    const sections = [...bySection.values()].map((section) => ({
      ...section,
      state:
        section.errors > 0 || section.pending > 0 || section.unanswered > 0
          ? ("blocked" as const)
          : section.warnings > 0
            ? ("needs_attention" as const)
            : ("complete" as const),
    }));
    const trigger = deriveHopeJ2051TriggerState(answerMap);
    return {
      assessmentId: input.assessment.id,
      version: input.assessment.version,
      specVersion: input.specVersionCode,
      isc: input.isc,
      status: input.assessment.status,
      signedAt: iso(input.assessment.signedAt),
      signedByMembershipId: input.assessment.signedByMembershipId,
      z0350: (answerMap.get("Z0350")?.value as string | undefined) ?? null,
      z0500b: (answerMap.get("Z0500B")?.value as string | undefined) ?? null,
      sections,
      progress,
      validation,
      sfv: {
        required: trigger.state === "pending" ? null : trigger.triggerFired,
        status: sfv?.status,
        dueAt: sfv?.dueAt.toISOString(),
        completedAt: sfv ? iso(sfv.completedAt) : undefined,
      },
      readiness: {
        readyToSign:
          input.assessment.status === "draft" &&
          blockers.length === 0 &&
          !validation.hasBlockingErrors,
        blockers,
      },
    };
  }

  return {
    async getReview(input) {
      return withOrgContext(
        db,
        { organizationId: input.organizationId, userId: "" },
        async (tx) => {
          const t = tx as unknown as DbClient;
          const [loaded] = await t
            .select({ assessment: A, specCode: V.code })
            .from(A)
            .innerJoin(V, eq(V.id, A.specVersionId))
            .where(and(eq(A.id, input.assessmentId), eq(A.organizationId, input.organizationId)))
            .limit(1);
          if (!loaded || !loaded.assessment.specVersionId || !loaded.assessment.isc) {
            throw new ConflictError(
              `HOPE assessment ${input.assessmentId} has no frozen spec version / ISC`,
            );
          }
          return evaluateCandidateInTx(t, {
            assessment: loaded.assessment,
            specVersionCode: loaded.specCode,
            isc: loaded.assessment.isc as HopeIsc,
            candidateZ0500B: input.candidateZ0500B,
          });
        },
      );
    },
    evaluateCandidateInTx,
  };
}
