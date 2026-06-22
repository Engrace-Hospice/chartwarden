// apps/backend/src/modules/07-care-plan/authoring — M7-T06 barrel for the §7.3–7.6 authoring helpers
// (discipline contribution + cross-discipline view, SUD per-caller redaction, goal-attribution view).
// Pure functions; the `discipline_scope` / `sud_disclosure_allowed` / `dpoa_active` ABAC predicates that
// gate the WRITE/READ paths live alongside in ../abac-predicates.ts and resolve through these.
export {
  type AuthoringDisciplineScope,
  type DisciplineTaggedEntry,
  IDG_COORDINATOR_ROLE,
  assertDisciplineScope,
  canAuthorInterventionDiscipline,
  disciplineCounts,
  groupInterventionsByDiscipline,
} from "./discipline";
export {
  type ProblemAnchored,
  type RedactableCarePlanView,
  type RedactableProblem,
  filterAnchoredToVisible,
  filterVisibleProblems,
  redactCarePlanForCaller,
  redactedSudProblemIds,
} from "./redaction";
export {
  type AttributableGoal,
  type GoalAttributionParty,
  type GoalAttributionView,
  projectGoalAttribution,
} from "./goal-attribution";
