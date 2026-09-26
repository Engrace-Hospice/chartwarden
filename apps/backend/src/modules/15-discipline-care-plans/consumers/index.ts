// apps/backend/src/modules/15-discipline-care-plans/consumers — M15-T03.
//
// The thin seam-consuming layer between M15's pure §2.2 lifecycle and the two modules M15 depends on:
// M7 (the IPOC problems/goals a discipline plan references) and M8 (the signed encounters a supervisory
// visit and a discipline assessment reference). Each function resolves the fact through the M1 seam
// registry and hands the pure machines a plain value — the machines stay deterministic and DB-free, and
// M15 keeps zero cross-module schema imports (architecture §25.15).
//
// F-103 — the first OUTBOX consumer in this directory. Everything below it is the seam-reading layer the
// header describes; `./m6-admission-activated` is the §1.1 D10 plan-stub bootstrap, and the only path by
// which a `discipline_care_plan` row has ever been created.
export {
  type AdmissionActivatedFacts,
  type AdmissionSitingResolver,
  type DisciplinePlanBootstrapDeps,
  M15_PLAN_BOOTSTRAP_CONSUMER,
  buildM15PlanBootstrapConsumer,
} from "./m6-admission-activated";
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
