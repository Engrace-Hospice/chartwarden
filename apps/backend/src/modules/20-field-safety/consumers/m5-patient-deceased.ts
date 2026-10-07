// apps/backend/src/modules/20-field-safety/consumers/m5-patient-deceased.ts — §4.4 `m5-patient-deceased.consumer`
// (GAP-135). A patient's death closes the safety obligations attached to that patient's upcoming visits.
//
// WITHOUT THIS CONSUMER the pre/mid/post check-in obligations `m17.visit.published` materialized stayed open after
// the death: the visit would never happen, the clinician would never check in against it, and the §4.8 detector
// would walk the D4 ladder (overdue -> escalated -> incident) at a clinician who is demonstrably fine, on a visit to
// a patient who has died.
//
// THE DECISION IS PURE, THE READS ARE THE BINDING'S. M5's payload names the patient, not the visits, and
// `safety_check_in_schedule` carries no patient column, so the binding resolves the decedent's upcoming visits through
// M17's published reader and hands this decider the open rows per visit. Only OPEN obligations are retired
// (`isOpenObligation`): a `recorded` row is history and an `incident_opened` one is a supervisor's act, neither a
// consumer's to rewrite. Retirement is the row's DELETE under the M4 write-audit trigger, with the reason on the
// record — the same representation every other M20 consumer uses for "this plan was invalidated".
import { withAudit } from "../lifecycle/effects";
import {
  type SafetyConsumerDecision,
  type SafetyScheduleMutation,
  type SafetyScheduleRowFacts,
  isOpenObligation,
} from "./schedule-plan";

/** Retire every open obligation on the decedent's upcoming visits. */
export function decidePatientDeceased(input: {
  /** The open-or-not rows of each of the decedent's upcoming visits, as `scheduleRowsForVisit` reads them. */
  readonly rowsByVisit: readonly (readonly SafetyScheduleRowFacts[])[];
}): SafetyConsumerDecision {
  const mutations: SafetyScheduleMutation[] = input.rowsByVisit
    .flat()
    .filter((row) => isOpenObligation(row.state))
    .map((row) => ({
      kind: "retire" as const,
      scheduleId: row.scheduleId,
      reason: "patient_deceased" as const,
    }));

  return { mutations, effects: mutations.length === 0 ? [] : withAudit([]), skipped: [] };
}
