// apps/backend/src/modules/08-encounters/lifecycle — M8-T04 (§2.3, §2.7, §2.8).
//
// The pure M8 domain core: the §2.3 encounter aggregate state machine (draft → finalized →
// {signed | cosign_pending → cosigned}, void from draft) + the §2.3 addendum sub-machine (draft →
// finalized → signed off a non-voided parent), the §2.7 synchronous validation catalog + the async
// (outbox-surfaced) catalog, and the §2.8 in-transaction side-effect descriptors. Every function is
// pure and deterministic (the clock, the Layer-3 gate verdict, step-up freshness, and all cross-module
// facts are injected) so the M8 service layer (M8-T09+) composes them inside the aggregate's
// optimistic-locked transaction. No IO, no cross-module schema import — the §2.4 cosignature SLA chain
// (T06) and §2.5 late-entry tiers (T07) build on the descriptors this task lands.
export {
  EncounterStateError,
  M8_ERROR_STATUS,
  require_,
  type M8ErrorCode,
} from "./errors";
export {
  result,
  type EncounterSideEffect,
  type TransitionResult,
} from "./effects";
export {
  ASYNC_VALIDATION_EVENTS,
  COSIGN_REQUIRED_DISCIPLINES,
  STEP_UP_MAX_AGE_SECONDS,
  TEXT_MINIMUMS,
  checkCosignerEligibility,
  checkEligibleCosignerExists,
  checkEncounterDisciplinePair,
  checkF2fDualWrite,
  checkLateEntryReason,
  checkMutableForEdit,
  checkParentNotVoided,
  checkServiceDateAfterAdmission,
  checkServiceDateNotFuture,
  checkStepUpFresh,
  checkVersion,
  checkVocabVersion,
  checkVolunteerAssignment,
  daysBetween,
} from "./validation";
export {
  ENCOUNTER_GRAPH,
  planDraftCreation,
  requiresCosignature,
  transitionEncounter,
  type EncounterEvent,
  type EncounterState,
  type EncounterTransition,
} from "./encounter";
export {
  ADDENDUM_GRAPH,
  planAddendumCreation,
  transitionAddendum,
  type AddendumEvent,
  type AddendumState,
  type AddendumTransition,
} from "./addendum";
