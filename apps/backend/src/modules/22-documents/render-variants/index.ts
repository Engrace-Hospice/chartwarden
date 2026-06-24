// apps/backend/src/modules/22-documents/render-variants — M22-T09 the §7.5/§7.12/§7.13/§7.15/§7.16 render
// variants + the SUD-redacted placeholder + the Statement-of-Disagreement attachment + the lab back-ref
// deny-stub.
//
// PHASE-1: pure render-planning + a forward-declared lab-results consumer (M29 lands in Wave H). All pure;
// the live render execution + the dispatcher binding are deferred (T06 precedent). M22 deps stay [1, 5] —
// every source-module event is read as a STRING literal + every cross-module seam is reached OPAQUELY via
// getSeam, so this directory adds no producer import and no dependency-cruiser edge.
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
  // §7.15 / §7.16 lab back-ref consumer (pure decider)
  M22_LAB_RESULTS_CONSUMER,
  M22_LAB_RESULTS_EVENT,
  decideLabBackref,
  type LabBackrefAction,
  type LabBackrefFacts,
  type LabResultsRequestPayload,
} from "./lab-backref-consumer";
export {
  // §7.15 lab back-ref forward-declared binding + M29 deny-stub resolver
  M22_LAB_RESULTS_BINDING,
  M22_LAB_RESULTS_BINDING_DEFERRED,
  resolveLabResultsPayload,
  type LabBackrefBinding,
  type LabObservationReaderPort,
} from "./lab-backref-bindings";
