// apps/backend/src/modules/28-fhir/seams — M28's seam boundary (§4.3–§4.4, M28-T06).
//
//   · ./consumed   the §4.4 accessors for the seams M28 READS (leaf-typed + opaque views + forward-seams)
//   · ./published  the §4.3 seam IMPLEMENTATIONS, over a T08 Drizzle store
//
// `registerFhirPublishedSeams` is §4.3's boot registration, driven from the composition root's
// `wireModuleSeams()` and therefore before `validateSeams()`. The store comes from
// `createDrizzleFhirPublishedSeamStore`, so a db boot registers all three; without a store the call is a
// NO-OP and the M1 fail-closed deny-stubs stand (the M19/M20 "no store ⇒ register nothing" posture).
export {
  type FhirBaaStatusView,
  type FhirClaimReaderView,
  type FhirMdmEntityView,
  type FhirTerminologyView,
  getFhirAiPromptRegistry,
  getFhirBaaStatusProvider,
  getFhirBillableEncounterReader,
  getFhirCarePlanReader,
  getFhirClaimReader,
  getFhirDisclosureConsentEvaluator,
  getFhirElectionPeriodReader,
  getFhirLabObservationReader,
  getFhirMdmEntityProvider,
  getFhirMedicationAdministrationProvider,
  getFhirMedicationOrderProvider,
  getFhirOrderProvider,
  getFhirPatientAddressReader,
  getFhirPatientReader,
  getFhirReconciliationProvider,
  getFhirSignedEncountersReader,
  getFhirTerminologyProvider,
} from "./consumed";
export {
  createFhirClientReader,
  createFhirGatewayMetricsProvider,
  createFhirInboundProposalReader,
  type FhirPublishedSeamDeps,
  type FhirPublishedSeamStore,
  registerFhirPublishedSeams,
} from "./published";
