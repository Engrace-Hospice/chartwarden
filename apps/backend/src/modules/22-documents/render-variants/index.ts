// apps/backend/src/modules/22-documents/render-variants — M22-T09 the §7.5/§7.12/§7.13/§7.15/§7.16 render
// variants + the SUD-redacted placeholder + the Statement-of-Disagreement attachment + (F-171, #248) the
// LIVE lab-results back-ref + (F-171, #248) the LIVE patient medication-list render.
//
// This directory is pure render-planning PLUS two dedicated (non-generic-REQUEST_SHAPES) live pipelines:
// `lab-backref-bindings.ts` (M29's `LabObservationReader` seam is real and registered in production, F-171)
// and `medication-list-bindings.ts` (M12's `MedicationOrderProvider` seam, F-171) — both genuinely wired
// into the composition root, not forward-declared. M22 deps stay [1, 5] regardless — every source-module
// event is read as a STRING literal + every cross-module seam is reached OPAQUELY via getSeam, so this
// directory adds no producer import and no dependency-cruiser edge.
export {
  // §7.16 SUD-redacted placeholder
  SUD_REDACTED_PLACEHOLDER,
  SUD_REDACTION_BANNER,
  SUD_RETENTION_CLASS,
  redactSudValue,
  // §7.12 / §7.13 / §7.15 render variants
  planEvvVerificationRender,
  planEncounterRender,
  planLabResultsRender,
  type RenderVariantResult,
  type EvvVerificationPayload,
  type EncounterRenderPayload,
  type LabResultValue,
  type LabResultsRenderPayload,
} from "./render-variants";
export {
  // §7.5 W5 Statement of Disagreement
  SOD_AMENDMENT_TAG,
  StatementOfDisagreementError,
  planStatementOfDisagreement,
  type AmendmentDeniedPayload,
  type SodAttachmentPlan,
  type SodRenderContent,
} from "./statement-of-disagreement";
export {
  // §7.15 / §7.16 lab back-ref consumer (pure decider) + the M29 DTO → render-payload mapping (F-171)
  M22_LAB_RESULTS_CONSUMER,
  M22_LAB_RESULTS_EVENT,
  buildLabResultsRenderPayload,
  decideLabBackref,
  type LabBackrefAction,
  type LabBackrefFacts,
  type LabObservationSeamDtoPort,
  type LabObservationSeamValuePort,
  type LabResultsRequestPayload,
} from "./lab-backref-consumer";
export {
  // §7.15 lab back-ref LIVE binding (F-171) — M29's real `LabObservationReader.getByObservationId` seam
  LabObservationUnresolvedError,
  M22_LAB_RESULTS_BINDING,
  M22_LAB_RESULTS_BINDING_DEFERRED,
  buildM22LabBackrefConsumer,
  resolveLabResultsPayload,
  type LabBackrefBinding,
  type LabBackrefConsumerDeps,
  type LabBackrefRenderedEmit,
  type LabObservationReaderPort,
} from "./lab-backref-bindings";
export {
  // F-171 (#248) — patient medication-list render variant (pure)
  planMedicationListRender,
  type PatientMedicationListEntry,
  type PatientMedicationListRenderPayload,
} from "./render-variants";
export {
  // F-171 (#248) — the medication-list render pipeline (pure decider)
  M22_MEDICATION_LIST_CONSUMER,
  M22_MEDICATION_LIST_EVENT,
  decideMedicationListRender,
  type MedicationListAction,
  type MedicationListChangedPayload,
  type MedicationListFacts,
} from "./medication-list-consumer";
export {
  // F-171 (#248) — the LIVE medication-list render binding
  MalformedMedicationListRequestError,
  buildM22MedicationListConsumer,
  resolveActiveMedicationsForPatient,
  type MedicationListConsumerDeps,
} from "./medication-list-bindings";
