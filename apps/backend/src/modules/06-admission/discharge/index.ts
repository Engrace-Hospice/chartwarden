// apps/backend/src/modules/06-admission/discharge — M6-T09 discharge / revocation / transfer / LOC
// (§6.3 reason-specific permission mapping + §7.6 workflows). PURE domain logic the route slice composes
// over: the §6.3 reason→permission derivation + per-reason narrative gates (permission-map), the
// M6-owned bereavement-eligibility rule (W-DC-01), the for-cause cosign cascade (W-DC-02), and the
// transfer-in inherited-period sequencing (W-DC-03). Revocation / transfer-out / LOC-change side-effect
// cascades live in the §2.3.6 command machines (state-machines/commands.ts, level-of-care.ts) the slice
// also drives — this submodule adds the cross-entity consequences the machines deliberately leave out.
export {
  DISCHARGE_REASONS,
  DISCHARGE_POLICY,
  DISCHARGE_FALLBACK_PERMISSION,
  type DischargeReason,
  type DischargePolicy,
  type DischargeNarrativeIssue,
  isDischargeReason,
  deriveDischargePermissionKey,
  dischargeRequiresCosign,
  checkDischargeNarrative,
  checkPlaceOfDeath,
  PLACES_OF_DEATH,
  type PlaceOfDeath,
} from "./permission-map";
export {
  type BereavementFacts,
  type BereavementEligibility,
  decideBereavementEligibility,
} from "./bereavement";
export {
  type ForCauseFiling,
  type ForCauseResolution,
  type ForCauseOutcome,
  fileForCauseDischarge,
  resolveForCauseDischarge,
} from "./for-cause";
export {
  type TransferInInput,
  type TransferInPeriodPlan,
  type TransferInPlan,
  planTransferIn,
} from "./transfer-in";
