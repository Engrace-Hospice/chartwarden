// apps/backend/src/modules/19-oncall/clinical — M19-T05: the three cross-module CLINICAL bindings (D8/D9/D15).
//
// `../consumers` and `../roster` (M19-T04) bind the modules that make a triage call HAPPEN — M17's roster,
// M17/M18's inbound triggers. This directory binds the modules a call REACHES INTO once it is happening:
// M8 (the encounter that documents it), M11 (a verbal order taken during it) and M12 (the medication and
// refill context the disposition is chosen against). All three go through the M1 seam registry or an outbox
// event name; none imports another module's schema.
export {
  type TriageEncounterCallFacts,
  type TriageEncounterLinkOutcome,
  type TriageEncounterLinkPort,
  type TriageEncounterPlan,
  CREATE_ENCOUNTER_EFFECT,
  encounterDisciplineFor,
  linkTriageEncounter,
  planTriageEncounter,
} from "./encounter-link";
export {
  type EncounterSignedPorts,
  type M8EncounterSignedPayload,
  type TriageDocumentedPlan,
  M8_ENCOUNTER_SIGNED_EVENT,
  decideEncounterSigned,
  planTriageDocumentation,
} from "./m8-encounter-signed";
export {
  type TriageVerbalOrderReceipt,
  type TriageVerbalOrderRequest,
  VERBAL_ATTESTATION_MAX_CHARS,
  VERBAL_ATTESTATION_MIN_CHARS,
  appendLinkedVerbalOrderId,
  assertVerbalOrderScope,
  assertVerbalOrderStepUp,
  buildVerbalOrderInput,
  recordTriageVerbalOrder,
  verbalOrderLinkEffect,
} from "./verbal-order";
export {
  type PrnAuthorizationTarget,
  type TriageMedicationContext,
  type TriageMedicationSlice,
  type TriageMedicationSummary,
  type TriageRefillSummary,
  readTriageMedicationContext,
  redactSudMedications,
  validatePrnAuthorizationTarget,
} from "./medication-context";
