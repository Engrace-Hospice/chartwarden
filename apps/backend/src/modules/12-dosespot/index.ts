// apps/backend/src/modules/12-dosespot — M12 (DoseSpot Integration) backend module surface.
//
// M12-T07 lands the two §2.10 D17 owned seams (MedicationOrderProvider — the medication-order read path
// M13/M14/M19/M28/M30/M31/M33 consume — + RefillInboxProvider — the refill-inbox read path the prescriber UI
// and M19/M33 consume) registered into the M1 registry via `registerDoseSpotSeams` (driven from the
// composition root's wireModuleSeams()).
export {
  type ComfortKitTimeline,
  type CostBasisRow,
  type DoseSpotSeamDeps,
  type DoseSpotSeamSeed,
  type DoseSpotSeamStore,
  createInMemoryDoseSpotSeamStore,
  createMedicationOrderProvider,
  createRefillInboxProvider,
  getDoseSpotConsentValidator,
  getDoseSpotMdmValidator,
  getDoseSpotTerminologyValidator,
  getMedicationOrderProvider,
  getRefillInboxProvider,
  registerDoseSpotSeams,
} from "./seams/index";
// M12-T08 — the §4.7 ABAC predicates M12 owns (`prescriber_eligible` / `dea_schedule_authorized` /
// `refill_inbox_scope`). The §4.6 permission keys M12 contributes to M3 live in @wardenx/auth
// (M12_CONTRIBUTED_PERMISSIONS).
export {
  type DoseSpotAbacDeps,
  M12_ABAC_PREDICATES,
  buildDoseSpotAbacPredicates,
  prescriberDisciplinesOf,
  registerDoseSpotAbacPredicates,
} from "./abac-predicates";
export {
  CONTROLLED_PRESCRIBE_DISCIPLINES,
  PRESCRIBE_DISCIPLINES,
  prescriberEligible,
} from "./prescriber-eligibility";
// M12-T08 — the §4.1 route inventory over an in-memory backend + the route service contract (in-mem slice;
// Drizzle in prod under withOrgContext so RLS backstops).
export { type DoseSpotRouteDeps, registerDoseSpotRoutes } from "./routes/dosespot-routes";
export {
  type ApproveRefillArgs,
  type ControlledSubstancePolicyView,
  type CreateMedicationOrderArgs,
  type DenyRefillArgs,
  type DiscontinueArgs,
  type DoseSpotAbacResolver,
  type DoseSpotConsentValidator,
  type DoseSpotMdmValidator,
  type DoseSpotRouteSeed,
  type DoseSpotTerminologyValidator,
  type MedicationOrderRouteService,
  type MedicationOrderView,
  type PrescriberRosterView,
  type RecordedDoseSpotEvent,
  type RecordVerbalArgs,
  type RefillInboxPolicyView,
  type RefillRequestView,
  type RefillScopeFacts,
  type SignArgs,
  createInMemoryDoseSpotBackend,
} from "./routes/service";
// M12-T08 — the §4.4 outbox contract (the full `m12.*` taxonomy; check-fitness-gaps.ts scans events-by-m12.ts
// for naming + ownership + declared consumers).
export { M12_OUTBOX_EVENTS } from "./events-by-m12";
// M12-T08 — the §4.5 outbox subscriptions: M5 patient-sync triggers + M6 discharge cascade / MedHx fetch + the
// M11 verbal-expiry backref. Pure deciders + the event → consumer binding registry; consumed event names are
// string literals (no dependsOn edge).
export {
  type AdmissionDischargedPayload,
  type AdmissionMedHxPayload,
  type MedHxFetchAction,
  type MedicationDischargeCascadeAction,
  type MedicationDischargeCascadeFacts,
  type MedicationDischargeDiscontinueAction,
  type MedicationOrderOnAdmission,
  type PatientChangedPayload,
  type PatientSyncTriggerAction,
  type VerbalExpiredAction,
  type VerbalExpiredFacts,
  type VerbalExpiredPayload,
  M12_OUTBOX_SUBSCRIPTIONS,
  decideMedHxFetch,
  decideMedicationDischargeCascade,
  decidePatientSyncTrigger,
  decideVerbalExpiry,
} from "./consumers/index";
