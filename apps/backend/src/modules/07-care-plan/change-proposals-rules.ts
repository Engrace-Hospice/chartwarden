// apps/backend/src/modules/07-care-plan/change-proposals-rules.ts — WF09: the pure half of the plan-of-care change proposals.
// A proposal body (one variant per kind, ./routes/change-proposal-typebox.ts) maps onto the `care_plan_change_proposal` columns, and a
// row maps back onto the read view under the request's own field names. No IO.
import type { schema } from "@chartwarden/db";
import { ValidationError } from "@chartwarden/types";
import { checkInterventionFrequency } from "./lifecycle/validation";
import type {
  CarePlanChangeProposalView,
  ChangeProposalChange,
} from "./routes/change-proposal-typebox";

type Row = typeof schema.carePlanChangeProposals.$inferSelect;
export type ChangeProposalKind = Row["kind"];
export type ProposalElementType = "problem" | "goal" | "intervention";

/** The columns a change writes. Every one the kind does not use is null, so a replace wipes the previous kind's. */
export interface ChangeColumns {
  readonly kind: ChangeProposalChange["kind"];
  readonly targetElementId: string | null;
  readonly problemId: string | null;
  readonly parentProposalId: string | null;
  readonly goalRefs: string[];
  readonly description: string | null;
  readonly icd10Code: string | null;
  readonly snomedCode: string | null;
  readonly problemKind: string | null;
  readonly problemSource: string | null;
  readonly onsetAt: Date | null;
  readonly resolutionNote: string | null;
  readonly goalText: string | null;
  readonly goalSource: string | null;
  readonly measurableOutcome: string | null;
  readonly targetAt: Date | null;
  readonly revisedText: string | null;
  readonly goalStatus: string | null;
  readonly scopeText: string | null;
  readonly frequencyText: string | null;
  readonly frequencyValue: string | null;
  readonly discipline: string | null;
  readonly responsibleRole: string | null;
  readonly discontinueReason: string | null;
  /** Set by the proposer on `problem_add`; null for every other kind, whose flag is copied from the problem it touches. */
  readonly sudRelated: boolean | null;
}

const EMPTY: Omit<ChangeColumns, "kind"> = {
  targetElementId: null,
  problemId: null,
  parentProposalId: null,
  goalRefs: [],
  description: null,
  icd10Code: null,
  snomedCode: null,
  problemKind: null,
  problemSource: null,
  onsetAt: null,
  resolutionNote: null,
  goalText: null,
  goalSource: null,
  measurableOutcome: null,
  targetAt: null,
  revisedText: null,
  goalStatus: null,
  scopeText: null,
  frequencyText: null,
  frequencyValue: null,
  discipline: null,
  responsibleRole: null,
  discontinueReason: null,
  sudRelated: null,
};

const dateOrNull = (iso: string | undefined): Date | null => (iso ? new Date(iso) : null);

/** The columns one change writes (visit-independent: the encounter, plan and actor are the caller's). */
export function columnsOf(change: ChangeProposalChange): ChangeColumns {
  switch (change.kind) {
    case "problem_add":
      return {
        ...EMPTY,
        kind: change.kind,
        description: change.description,
        problemKind: change.problemKind,
        problemSource: change.problemSource ?? "clinical",
        icd10Code: change.icd10Code ?? null,
        snomedCode: change.snomedCode ?? null,
        onsetAt: dateOrNull(change.onsetAt),
        sudRelated: change.sudRelated ?? false,
      };
    case "problem_resolve":
      return {
        ...EMPTY,
        kind: change.kind,
        targetElementId: change.problemId,
        resolutionNote: change.resolutionNote,
      };
    case "goal_add":
      return {
        ...EMPTY,
        kind: change.kind,
        problemId: change.problemId ?? null,
        parentProposalId: change.parentProposalId ?? null,
        goalText: change.originalText,
        goalSource: change.goalSource ?? "clinical",
        measurableOutcome: change.measurableOutcome ?? null,
        targetAt: dateOrNull(change.targetAt),
      };
    case "goal_update":
      return {
        ...EMPTY,
        kind: change.kind,
        targetElementId: change.goalId,
        revisedText: change.revisedText ?? null,
        measurableOutcome: change.measurableOutcome ?? null,
        goalStatus: change.goalStatus ?? null,
        targetAt: dateOrNull(change.targetAt),
      };
    case "intervention_add":
      return {
        ...EMPTY,
        kind: change.kind,
        problemId: change.problemId ?? null,
        parentProposalId: change.parentProposalId ?? null,
        goalRefs: [...new Set(change.goalRefs ?? [])],
        scopeText: change.scopeText,
        frequencyText: change.frequencyText,
        frequencyValue: change.frequencyValue,
        discipline: change.discipline,
        responsibleRole: change.responsibleRole ?? null,
      };
    case "intervention_discontinue":
      return {
        ...EMPTY,
        kind: change.kind,
        targetElementId: change.interventionId,
        discontinueReason: change.reason,
      };
  }
}

const invalid = (field: string, message: string): ValidationError =>
  new ValidationError(message, [{ field, code: "INVALID", message }]);

/**
 * The rules TypeBox cannot state. A goal or intervention names EITHER an existing problem OR a problem proposal of the same visit; a goal
 * update changes something; an intervention carries a real frequency (the manual route's own §2.3 check, run early so the author hears
 * about it while writing the note rather than when a supervisor accepts).
 */
export function assertChangeConsistent(change: ChangeProposalChange): void {
  if (change.kind === "goal_add" || change.kind === "intervention_add") {
    if ((change.problemId === undefined) === (change.parentProposalId === undefined)) {
      throw invalid(
        "problemId",
        `a ${change.kind === "goal_add" ? "goal" : "intervention"} must name exactly one of problemId (an existing problem) or parentProposalId (a problem proposed in this visit)`,
      );
    }
  }
  if (change.kind === "goal_update") {
    const changes = [
      change.revisedText,
      change.measurableOutcome,
      change.goalStatus,
      change.targetAt,
    ];
    if (changes.every((c) => c === undefined)) {
      throw invalid(
        "goalId",
        "a goal update must change at least one of revisedText, measurableOutcome, goalStatus or targetAt",
      );
    }
  }
  if (change.kind === "intervention_add") checkInterventionFrequency(change.frequencyValue);
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

type ChangeSource = Omit<ChangeColumns, "kind" | "sudRelated" | "problemKind" | "problemSource"> & {
  readonly problemKind: string | null;
  readonly problemSource: string | null;
};

/** A row's proposed fields under the request body's own names (`originalText`, `reason`, …); null where the kind does not carry one. */
export function changeViewOf(row: ChangeSource): CarePlanChangeProposalView["change"] {
  return {
    description: row.description,
    problemKind: row.problemKind as CarePlanChangeProposalView["change"]["problemKind"],
    problemSource: row.problemSource as CarePlanChangeProposalView["change"]["problemSource"],
    icd10Code: row.icd10Code,
    snomedCode: row.snomedCode,
    onsetAt: iso(row.onsetAt),
    resolutionNote: row.resolutionNote,
    originalText: row.goalText,
    goalSource: row.goalSource as CarePlanChangeProposalView["change"]["goalSource"],
    measurableOutcome: row.measurableOutcome,
    targetAt: iso(row.targetAt),
    revisedText: row.revisedText,
    goalStatus: row.goalStatus as CarePlanChangeProposalView["change"]["goalStatus"],
    goalRefs: [...row.goalRefs],
    scopeText: row.scopeText,
    frequencyText: row.frequencyText,
    frequencyValue: row.frequencyValue,
    discipline: row.discipline as CarePlanChangeProposalView["change"]["discipline"],
    responsibleRole: row.responsibleRole,
    reason: row.discontinueReason,
  };
}

/**
 * The element a change touches: the one it resolves / updates / discontinues, or the problem a new goal / intervention hangs off (null
 * id when that problem is itself a proposal). A new problem touches nothing.
 */
export function targetRefOf(
  row: { readonly kind: string } & Pick<ChangeColumns, "targetElementId" | "problemId">,
): { type: ProposalElementType; id: string | null } | null {
  switch (row.kind) {
    case "problem_add":
      return null;
    case "problem_resolve":
      return { type: "problem", id: row.targetElementId };
    case "goal_add":
    case "intervention_add":
      return { type: "problem", id: row.problemId };
    case "goal_update":
      return { type: "goal", id: row.targetElementId };
    case "intervention_discontinue":
      return { type: "intervention", id: row.targetElementId };
    default:
      return null;
  }
}
