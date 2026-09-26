// apps/backend/src/modules/07-care-plan/lifecycle — M7-T03 (§2.2 lifecycle, §2.3 validation).
//
// The pure M7 care-plan domain core: the §2.2.1 care_plan root machine, the §2.2.2 care_plan_version
// hybrid-versioning + signature machine (with the §11 D5 Required Signer Set quorum), the §2.2.3
// problem/goal/intervention element machines, and the §2.3 synchronous validation catalog. Every
// function is pure and deterministic (the clock and all cross-module facts are injected) so the M7
// service layer (M7-T05+) composes them inside the version aggregate's optimistic-locked transaction.
// No IO, no cross-module schema import — guard facts (M38 ICD-10, M39 DPOA consent) are resolved by the
// caller and passed in. Mirrors the M6 `state-machines/` precedent.
export {
  CarePlanStateError,
  M7_ERROR_STATUS,
  require_,
  type M7ErrorCode,
} from "./errors";
export {
  result,
  type CarePlanSideEffect,
  type TransitionResult,
} from "./effects";
export {
  CARE_PLAN_GRAPH,
  openCarePlan,
  transitionCarePlan,
  type CarePlanDischargeReason,
  type CarePlanEvent,
  type CarePlanLifecycleState,
  type CarePlanTransition,
} from "./care-plan";
export {
  CARE_PLAN_VERSION_GRAPH,
  openCarePlanVersion,
  transitionCarePlanVersion,
  type CarePlanVersionEvent,
  type CarePlanVersionState,
  type CarePlanVersionTransition,
} from "./version";
export {
  decideRecordSignature,
  isQuorumMet,
  resolveRequiredSignerSet,
  roleSatisfiesSlot,
  type SignatureDecision,
} from "./required-signer-set";
export {
  GOAL_GRAPH,
  INTERVENTION_GRAPH,
  PROBLEM_GRAPH,
  transitionGoal,
  transitionIntervention,
  transitionProblem,
  type GoalEvent,
  type GoalLifecycleState,
  type GoalTransition,
  type InterventionEvent,
  type InterventionLifecycleState,
  type InterventionTransition,
  type ProblemEvent,
  type ProblemLifecycleState,
  type ProblemTransition,
} from "./elements";
export {
  INITIAL_GATE_GRACE_DAYS,
  REVIEW_GATE_GRACE_DAYS,
  evaluateCarePlanOverdue,
  type CarePlanClockFacts,
} from "./overdue-gate";
export {
  DEFAULT_ORG_TIME_ZONE,
  GATE_WARNING_LEAD_DAYS,
  INITIAL_DUE_DAYS,
  REVIEW_INTERVAL_DAYS,
  addCalendarDays,
  computeInitialDueAt,
  computeNextReviewDueAt,
  endOfOrgDayInstant,
  orgLocalDateOf,
  warningOpensAt,
} from "./gate-clock";
export {
  TEXT_MINIMUMS,
  checkDpoaGoalConsent,
  checkGoalReferencesProblem,
  checkInitialHasProblem,
  checkInterventionFrequency,
  checkInterventionReferencesProblem,
  checkOptimisticConcurrency,
  checkPatientStatedGoalVerbatim,
  checkTerminalProblemPresent,
  isVerbatimGoalSource,
} from "./validation";
