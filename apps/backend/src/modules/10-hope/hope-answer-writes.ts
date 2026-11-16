// apps/backend/src/modules/10-hope/hope-answer-writes.ts — the pure and the row-writing halves of a canonical answer patch,
// split out of `hope-answer-service.ts`: bring the proposed answers in line with the applicability verdicts, then write
// (or delete) every touched item's answer. Both run on a transaction that ALREADY holds the assessment row lock
// (M10's lock order: SFV row, assessment row, answers); neither takes one.
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";
import type { LockedAssessment } from "./hope-assessment-lock";
import type {
  HopeAnswerMap,
  HopeAnswerSnapshot,
  HopeApplicabilityItemResult,
} from "./spec/applicability";

type SpecItemRow = typeof schema.hopeSpecItems.$inferSelect;
const ANS = schema.hopeAssessmentAnswers;

/**
 * The proposed answers brought in line with the applicability verdicts: a skip no longer applies is dropped, a
 * not-applicable item becomes `skipped`, a pending item loses its answer. Returns the reconciled answers and the item
 * codes the patch touches (the requested ones plus every one reconciliation changed); neither input is modified.
 */
export function reconcileWithApplicability(
  proposed: HopeAnswerMap,
  applicability: { readonly items: ReadonlyMap<string, HopeApplicabilityItemResult> },
  requested: ReadonlySet<string>,
): { readonly answers: Map<string, HopeAnswerSnapshot>; readonly touched: Set<string> } {
  const answers = new Map(proposed);
  const touched = new Set(requested);
  for (const [itemCode, itemState] of applicability.items) {
    if (itemState.applicability === "applicable") {
      if (answers.get(itemCode)?.state === "skipped") {
        answers.delete(itemCode);
        touched.add(itemCode);
      }
    } else if (itemState.applicability === "not_applicable") {
      answers.set(itemCode, { state: "skipped", value: null });
      touched.add(itemCode);
    } else if (answers.has(itemCode)) {
      answers.delete(itemCode);
      touched.add(itemCode);
    }
  }
  return { answers, touched };
}

/** The columns every answer row of one assessment shares. */
type AnswerRowBase = Pick<
  typeof ANS.$inferInsert,
  "organizationId" | "providerEntityId" | "locationId" | "hopeAssessmentId" | "specVersionId"
>;

/** A pattern-skipped item: derived, with the applicability rule that skipped it as the reason. */
async function upsertSkippedAnswer(
  tx: DbClient,
  base: AnswerRowBase,
  specItemId: string,
  reason: HopeApplicabilityItemResult["reason"],
  now: Date,
): Promise<void> {
  const sourceReference = reason
    ? { reason: "skip_pattern", ...reason }
    : { reason: "skip_pattern" };
  await tx
    .insert(ANS)
    .values({
      ...base,
      specItemId,
      state: "skipped",
      value: null,
      source: "derived",
      sourceReference,
      answeredAt: now,
    })
    .onConflictDoUpdate({
      target: [ANS.hopeAssessmentId, ANS.specItemId],
      set: {
        state: "skipped",
        value: null,
        source: "derived",
        sourceReference,
        answeredAt: now,
        answeredByMembershipId: null,
        updatedAt: now,
      },
    });
}

/** An item the clinician answered. */
async function upsertUserAnswer(
  tx: DbClient,
  base: AnswerRowBase,
  specItemId: string,
  value: unknown,
  membershipId: string,
  now: Date,
): Promise<void> {
  await tx
    .insert(ANS)
    .values({
      ...base,
      specItemId,
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
        sourceReference: null,
        answeredAt: now,
        answeredByMembershipId: membershipId,
        updatedAt: now,
      },
    });
}

/** Write (or delete) every touched item's answer: a cleared or pending one is deleted, a skipped one is derived. */
export async function persistTouchedAnswers(input: {
  readonly tx: DbClient;
  readonly assessment: LockedAssessment;
  readonly membershipId: string;
  readonly itemsByCode: ReadonlyMap<string, SpecItemRow>;
  readonly touched: ReadonlySet<string>;
  readonly answers: ReadonlyMap<string, HopeAnswerSnapshot>;
  readonly applicability: { readonly items: ReadonlyMap<string, HopeApplicabilityItemResult> };
  readonly now: Date;
}): Promise<void> {
  const { tx, assessment, membershipId, itemsByCode, touched, answers, applicability, now } = input;
  const base: AnswerRowBase = {
    organizationId: assessment.organizationId,
    providerEntityId: assessment.providerEntityId,
    locationId: assessment.locationId,
    hopeAssessmentId: assessment.id,
    specVersionId: assessment.specVersionId!,
  };
  for (const itemCode of touched) {
    const item = itemsByCode.get(itemCode);
    if (!item) continue;
    const answer = answers.get(itemCode);
    if (!answer) {
      await tx
        .delete(ANS)
        .where(and(eq(ANS.hopeAssessmentId, assessment.id), eq(ANS.specItemId, item.id)));
    } else if (answer.state === "skipped") {
      await upsertSkippedAnswer(tx, base, item.id, applicability.items.get(itemCode)?.reason, now);
    } else {
      await upsertUserAnswer(tx, base, item.id, answer.value, membershipId, now);
    }
  }
}
