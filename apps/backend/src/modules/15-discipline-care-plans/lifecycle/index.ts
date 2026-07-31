// apps/backend/src/modules/15-discipline-care-plans/lifecycle — M15-T03 (§2.2 lifecycle, §2.3 validation).
//
// The pure M15 discipline-plan domain core: the §2.2.1 plan-root machine, the §2.2.2 version + signature
// machine over the SEALED §3.5 D11 quorum, the §2.2.3 goal/intervention/assessment element machines, the
// §2.2.4 / §7.1 supervisory cadence (the 14-day 418.76(h) clock + the day-16 encounter-sign gate), the
// §1.1 D10 initial-assessment clocks, and the §2.3 synchronous validation catalog.
//
// Every function is pure and deterministic — the clock and all cross-module facts are injected — so the
// M15 service layer (M15-T06 routes, M15-T04 workers) composes them inside the aggregate's
// optimistic-locked (§2.5 `If-Match`) transaction. No IO, no cross-module schema import: the M7 care-plan
// facts and the M8 signed-encounter facts are resolved through the boot-registered seams in
// `../consumers` and passed in as plain values. Mirrors the M7 `lifecycle/` precedent (§2.2.2 IS M7 D1).
export {
  DisciplinePlanStateError,
  M15_ERROR_STATUS,
  require_,
  type M15ErrorCode,
} from "./errors";
export { result, type DisciplinePlanSideEffect, type TransitionResult } from "./effects";
export {
  DISCIPLINE_PLAN_GRAPH,
  bootstrapDisciplinePlan,
  isBootstrappedOnAdmissionActivated,
  transitionDisciplinePlan,
  type DisciplinePlanBootstrap,
  type DisciplinePlanDischargeReason,
  type DisciplinePlanEvent,
  type DisciplinePlanLifecycleState,
  type DisciplinePlanTransition,
} from "./plan";
export {
  DISCIPLINE_VERSION_GRAPH,
  openDisciplinePlanVersion,
  transitionDisciplinePlanVersion,
  type DisciplinePlanVersionEvent,
  type DisciplinePlanVersionState,
  type DisciplinePlanVersionTransition,
  type FinalizeReadiness,
} from "./version";
export {
  checkQuorumSatisfied,
  decideRecordSignature,
  isQuorumMet,
  resolveRequiredSignerSet,
  roleSatisfiesSlot,
  type DisciplineSignatureDecision,
} from "./required-signer-set";
export {
  DISCIPLINE_ASSESSMENT_GRAPH,
  DISCIPLINE_GOAL_GRAPH,
  DISCIPLINE_INTERVENTION_GRAPH,
  transitionDisciplineAssessment,
  transitionDisciplineGoal,
  transitionDisciplineIntervention,
  type DisciplineAssessmentEvent,
  type DisciplineAssessmentLifecycleState,
  type DisciplineAssessmentTransition,
  type DisciplineGoalEvent,
  type DisciplineGoalLifecycleState,
  type DisciplineGoalTransition,
  type DisciplineInterventionEvent,
  type DisciplineInterventionLifecycleState,
  type DisciplineInterventionTransition,
} from "./elements";
export {
  advancesSupervisoryClock,
  computeNextSupervisoryDueAt,
  decideRecordSupervisoryVisit,
  effectiveCadenceDays,
  evaluateSupervisoryCadence,
  hoursOverdue,
  isSupervisoryGateEngaged,
  type SupervisoryClockFacts,
  type SupervisoryVisitDecision,
  type SupervisoryVisitFacts,
} from "./supervisory";
export {
  evaluateInitialClock,
  isInitialClockSatisfied,
  type InitialClockFacts,
  type InitialClockState,
} from "./initial-clock";
export {
  TEXT_MINIMUMS,
  checkAuthoringDiscipline,
  checkDeclinationImmutable,
  checkDpoaGoalConsent,
  checkGoalTextVerbatim,
  checkInterventionFrequency,
  checkOptimisticConcurrency,
  checkOptionalParentElement,
  checkParentProblem,
  checkPlanWritable,
  checkSnapshotUnsealed,
  checkVolunteerOutOfScopeAcknowledged,
  isVerbatimGoalSource,
} from "./validation";
