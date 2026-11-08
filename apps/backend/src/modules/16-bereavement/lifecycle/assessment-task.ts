// apps/backend/src/modules/16-bereavement/lifecycle/assessment-task.ts — ADR-0109 D3/D5.
//
// The pure rules around `bereavement_assessment_task` (the initial d28 and midpoint d180 risk-assessment checkpoints):
// who may complete one and from which state, when one is overdue, and how a stored score exposes the human-entered factors
// the next score carries forward. No IO; the write service and the hourly miss pass apply them.
import {
  BEREAVEMENT_RISK_FACTOR_NAMES,
  type BereavementAssessmentTaskKind,
  type ManualRiskFactors,
} from "@chartwarden/bereavement";
import type { BereavementFactorValue, BereavementRiskFactorName } from "@chartwarden/types";
import { BereavementStateError } from "./errors";

export type AssessmentTaskStatus = "scheduled" | "completed" | "missed" | "cancelled";

/** The task facts the rules decide over. */
export interface AssessmentTaskFacts {
  readonly status: AssessmentTaskStatus;
  readonly planId: string;
  readonly bereavedContactId: string;
  readonly taskKind: BereavementAssessmentTaskKind;
  readonly lateGraceUntil: Date;
}

/**
 * A human-appended score may complete a `scheduled` task, or a `missed` one (a late assessment still closes it). A
 * `completed` or `cancelled` task is refused; a task on another plan is invisible (404); a score for a different contact
 * than the task belongs to is a client error (422), because the task's contact is who the assessment is about.
 */
export function assertTaskCompletable(
  task: AssessmentTaskFacts,
  scope: { readonly planId: string; readonly contactId?: string | undefined },
): void {
  if (task.planId !== scope.planId) {
    throw new BereavementStateError(
      "ASSESSMENT_TASK_NOT_FOUND",
      "assessment task not found on this plan",
    );
  }
  if (scope.contactId !== undefined && scope.contactId !== task.bereavedContactId) {
    throw new BereavementStateError(
      "ASSESSMENT_TASK_CONTACT_MISMATCH",
      "the assessment task belongs to a different bereaved contact",
    );
  }
  if (task.status !== "scheduled" && task.status !== "missed") {
    throw new BereavementStateError(
      "ASSESSMENT_TASK_NOT_OPEN",
      `the assessment task is ${task.status} and cannot be completed`,
    );
  }
}

/** The miss pass's test: a task still `scheduled` after its late grace. */
export function isAssessmentTaskOverdue(
  task: Pick<AssessmentTaskFacts, "status" | "lateGraceUntil">,
  now: Date,
): boolean {
  return task.status === "scheduled" && task.lateGraceUntil.getTime() < now.getTime();
}

const FACTOR_NAMES: readonly string[] = BEREAVEMENT_RISK_FACTOR_NAMES;

/**
 * The human-entered factors a stored score carried (`risk_factors_jsonb.manualFactors`). They are sticky: the next score
 * merges its own manual input over them ("true wins"), so a later automatic recompute does not forget what a counselor
 * recorded. Reads defensively — the column is jsonb — keeping only known factor names with a tri-state value.
 */
export function stickyManualFactorsOf(riskFactorsJsonb: unknown): ManualRiskFactors {
  const raw = (riskFactorsJsonb as { manualFactors?: unknown } | null | undefined)?.manualFactors;
  if (typeof raw !== "object" || raw === null) return {};
  const out: Partial<Record<BereavementRiskFactorName, BereavementFactorValue>> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!FACTOR_NAMES.includes(name)) continue;
    if (value === true || value === false || value === "unknown") {
      out[name as BereavementRiskFactorName] = value;
    }
  }
  return out;
}
