// @chartwarden/bereavement — ADR-0109 D3: the assessment checkpoints.
//
// Two risk-assessment checkpoints ride the cadence — an initial assessment on day 28 and a midpoint
// reassessment on day 180 — but they are TASKS, not outreach rows. An outreach row for a checkpoint would count
// in the M30 CoP outreach numerator for a contact nobody made, so the checkpoints get their own ledger
// (`bereavement_assessment_task`, a later change). This module is the pure data + generator the table will
// materialize from. PURE — no IO, `@chartwarden/types`-only.

import { OUTREACH_LATE_ATTEMPT_GRACE_DAYS, deathAnchoredInstant } from "../policy";

export type BereavementAssessmentTaskKind = "initial_assessment" | "midpoint_reassessment";

export interface BereavementAssessmentFloorItem {
  readonly taskKind: BereavementAssessmentTaskKind;
  /** Days from the UTC-midnight death date. */
  readonly offsetDays: number;
}

/** The checkpoints, in due order. */
export const BEREAVEMENT_ASSESSMENT_FLOOR: readonly BereavementAssessmentFloorItem[] = [
  { taskKind: "initial_assessment", offsetDays: 28 },
  { taskKind: "midpoint_reassessment", offsetDays: 180 },
];

/** How long past `due_at` a checkpoint may still be completed before the miss pass marks it `missed`. The same
 *  window outreach rows get, so the two ledgers go overdue on the same clock. */
export const ASSESSMENT_LATE_GRACE_DAYS = OUTREACH_LATE_ATTEMPT_GRACE_DAYS;

/** One checkpoint, materialized against a death date. */
export interface PlannedAssessmentTask {
  readonly taskKind: BereavementAssessmentTaskKind;
  readonly dueAt: string;
  readonly lateGraceUntil: string;
}

/**
 * Materialize the checkpoints for a death date. `fromIso` makes it forward-only (a checkpoint whose date has
 * passed is not backdated). A malformed death date throws a `RangeError`.
 */
export function generateAssessmentTasks(
  deathDate: string,
  options: { readonly fromIso?: string } = {},
): ReadonlyArray<PlannedAssessmentTask> {
  const fromMs =
    options.fromIso === undefined ? Number.NEGATIVE_INFINITY : Date.parse(options.fromIso);
  return BEREAVEMENT_ASSESSMENT_FLOOR.map(
    (item): PlannedAssessmentTask => ({
      taskKind: item.taskKind,
      dueAt: deathAnchoredInstant(deathDate, item.offsetDays),
      lateGraceUntil: deathAnchoredInstant(deathDate, item.offsetDays + ASSESSMENT_LATE_GRACE_DAYS),
    }),
  ).filter((task) => Date.parse(task.dueAt) >= fromMs);
}
