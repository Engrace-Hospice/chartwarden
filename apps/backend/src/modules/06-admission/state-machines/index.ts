// apps/backend/src/modules/06-admission/state-machines — M6-T04 (§2.3, §2.4, §2.5).
//
// The pure M6 domain core: the five §2.3 aggregate state machines (Admission, ElectionPeriod, CTI,
// F2F, LevelOfCarePeriod) + the §2.3.6 revocation/transfer/discharge command-cascades, the §2.4
// synchronous validation catalog, and the §2.5 in-transaction side-effect descriptors. Every function
// is pure and deterministic (the clock and all cross-module facts are injected) so the M6 service
// layer (M6-T06+) composes them inside the aggregate's optimistic-locked transaction. No IO, no
// cross-module schema import — guard facts (M5 privacy flags, M38 ICD-10, M39 consent, M40 NPI) are
// resolved by the caller and passed in.
export {
  AdmissionStateError,
  M6_ERROR_STATUS,
  require_,
  type M6ErrorCode,
} from "./errors";
export {
  result,
  type ElectionEndCause,
  type SideEffect,
  type TransitionResult,
} from "./effects";
export {
  CTI_SUBMIT_WINDOW,
  DEFERRED_VALIDATION_EVENTS,
  F2F_PRIOR_WINDOW,
  SYNC_VALIDATION_RULES,
  TEXT_MINIMUMS,
  checkAttendingSignature,
  checkBenefitPeriodSequence,
  checkCurativeCareAck,
  checkDeathCertifier,
  checkF2fOverride,
  checkF2fPerformer,
  checkF2fWindow,
  checkNoConcurrentElection,
  checkRepresentativeAuthority,
  checkTerminalDxAllowable,
  checkWindowOverride,
  daysBetween,
  type SyncValidationRuleId,
} from "./validation";
export {
  ADMISSION_GRAPH,
  transitionAdmission,
  type AdmissionEvent,
  type AdmissionState,
  type AdmissionTransition,
} from "./admission";
export {
  ELECTION_PERIOD_GRAPH,
  ELECTION_PERIOD_LENGTH_DAYS,
  RECERT_SEQUENCE_FLOOR,
  electionPeriodKindForSequence,
  electionPeriodScheduledEnd,
  transitionElectionPeriod,
  type ElectionPeriodEvent,
  type ElectionPeriodState,
  type ElectionPeriodTransition,
} from "./election-period";
export {
  CERTIFICATION_GRAPH,
  transitionCertification,
  type CertificationEvent,
  type CertificationState,
  type CertificationTransition,
} from "./certification";
export {
  F2F_ENCOUNTER_LOCATIONS,
  TELEHEALTH_F2F_ALLOWED_THROUGH,
  TELEHEALTH_F2F_EXCLUSIONS_FROM,
  checkF2fModality,
  checkF2fSignedNote,
  type F2fEncounterLocation,
  type SignedNoteFacts,
  type TelehealthEligibilityAttestation,
} from "./f2f-attestation-rules";
export {
  FACE_TO_FACE_GRAPH,
  transitionFaceToFace,
  type FaceToFaceEvent,
  type FaceToFaceState,
  type FaceToFaceTransition,
} from "./face-to-face";
export {
  LEVEL_OF_CARE_GRAPH,
  needsIpuBed,
  transitionLevelOfCare,
  type LevelOfCareEvent,
  type LevelOfCareState,
  type LevelOfCareTransition,
} from "./level-of-care";
export {
  planDischarge,
  planRevocation,
  planTransferOut,
  validateTransferIn,
  type CommandCascade,
} from "./commands";
export {
  ADDENDUM_TEXT_MINIMUM,
  ELECTION_ADDENDUM_GRAPH,
  SETTLED_ADDENDUM_STATUSES,
  checkAddendumItems,
  exemptionEventFor,
  missingAddendumContent,
  transitionElectionAddendum,
  type AddendumContentFacts,
  type AddendumItemInput,
  type ElectionAddendumEmission,
  type ElectionAddendumEvent,
  type ElectionAddendumEventType,
  type ElectionAddendumTransition,
} from "./election-addendum";
