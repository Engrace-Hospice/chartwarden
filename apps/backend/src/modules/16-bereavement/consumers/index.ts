// apps/backend/src/modules/16-bereavement/consumers — the seam-consuming + outbox-subscribing layer
// (M16-T03).
//
//   • ./death-discharge — resolves the death instant + its D16 provenance through M6's `DeathDischargeReader`
//     and `AdmissionStatusReader` (M6's merged event carries neither; see that file's header)
//   • ./m6-eligibility  — the §4.3.1 `m6.bereavement.eligible` intake decider that CLOSES M6's bereavement
//     outbox, plus the D18 `m6.discharge.cosigned` gate-release decider
//
// Both are PURE decision cores over resolved facts (the M7 `apply-idg-decision` precedent). The live outbox
// bindings + the transactional writes land with the §4.9 workers in M16-T06.
export {
  DEATH_DISCHARGE_LOOKBACK_DAYS,
  type ResolvedDeathFact,
  externalSourceMetadataFor,
  resolveDeathFact,
  localDateOf,
} from "./death-discharge";
export {
  type CosignReceiptAction,
  type EligibilityIntakeAction,
  type EligibilityIntakeFacts,
  type M6BereavementEligiblePayload,
  type M6DischargeCosignedPayload,
  M6_BEREAVEMENT_ELIGIBLE_EVENT,
  M6_DISCHARGE_COSIGNED_EVENT,
  decideCosignReceipt,
  decideEligibilityIntake,
} from "./m6-eligibility";
