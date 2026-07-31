// apps/backend/src/modules/15-discipline-care-plans/consumers — M15-T03.
//
// The thin seam-consuming layer between M15's pure §2.2 lifecycle and the two modules M15 depends on:
// M7 (the IPOC problems/goals a discipline plan references) and M8 (the signed encounters a supervisory
// visit and a discipline assessment reference). Each function resolves the fact through the M1 seam
// registry and hands the pure machines a plain value — the machines stay deterministic and DB-free, and
// M15 keeps zero cross-module schema imports (architecture §25.15).
export {
  assertParentElements,
  relevantIpocElements,
  type ParentElementRefs,
} from "./care-plan-elements";
export {
  ENCOUNTER_LOOKBACK_DAYS,
  isAssessmentEncounterValid,
  isSupervisoryEncounterValid,
  type AssessmentEncounterRef,
  type SupervisoryEncounterRef,
} from "./signed-encounters";
export {
  resolveVolunteerVisitCandidates,
  type VolunteerServedPatient,
} from "./volunteer-visits";
