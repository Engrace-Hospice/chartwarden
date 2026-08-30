// apps/backend/src/modules/16-bereavement/consumers — the seam-consuming + outbox-subscribing layer
// (M16-T03).
//
//   • ./death-discharge — resolves the death instant + its D16 provenance through M6's `DeathDischargeReader`
//     and `AdmissionStatusReader` (M6's merged event carries neither; see that file's header)
//   • ./m6-eligibility  — the §4.3.1 `m6.bereavement.eligible` intake decider that CLOSES M6's bereavement
//     outbox, plus the D18 `m6.discharge.cosigned` gate-release decider
//
// Both are PURE decision cores over resolved facts (the M7 `apply-idg-decision` precedent).
//
// F-105 — that last sentence used to read "the live outbox bindings + the transactional writes land with
// the §4.9 workers in M16-T06", and it had gone on saying so long after the boot dispatcher landed. The
// intake half is now BOUND (../outbox-consumers/m6-bereavement-eligible.ts) and is the only path by which
// a `bereavement_plan` row can come into existence. `decideCosignReceipt` is still bound by nothing, and
// registered in `scripts/outbox-subscription-exceptions.ts` with the reason: M6's `discharge_event` models
// no external source, so its `DeathDischargeReader` returns `internal_clinician_recorded` for EVERY
// decedent, no plan can carry `external_source_metadata`, and there is no D18 gate for a receipt to
// release. The payload does not fit either — `m6.discharge.cosigned` carries `dischargeEventId` +
// `medicalDirectorCosignedAt`, and the decider reads `sourceProposalId` + `cosignedAt` +
// `medicalDirectorMembershipId`. Both halves are producer-side gaps in M6.
export {
  type AdmissionAnchorResolver,
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
