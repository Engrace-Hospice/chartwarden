// apps/backend/src/modules/22-documents/render-variants — M22-T09 the §7 render-variant consumers.
//
// The variant-specific render paths layered over the §4.11 render-handshake core (M22-T06): the §164.526
// Statement-of-Disagreement pipeline (§7.5 W5 / D13), the SUD-aware lab-results render with the M29 reader
// deny-stub (§7.15 W-M22-22 / §7.16 W-M22-23 / §7.18 W-M22-25, M29 = Wave H), and the EVV (§7.12 W12) / encounter
// (§7.13 W13) layout variants. The pure payload shaping (incl. the D20 SUD redaction) lives in `@wardenx/forms`;
// these consumers add the org/patient guards, the seam hydration (deny-stubbed for M29), and the outbox intents.
export {
  type LabObservationReader,
  type LabObservationReaderUnavailableReason,
  type ResolvedLabObservation,
  denyStubLabObservationReader,
} from "./m29-lab-observation-reader";
export {
  type LabResultsRenderResolution,
  resolveLabResultsRender,
} from "./lab-results-consumer";
export {
  type StatementOfDisagreementPublishedEvent,
  type StatementOfDisagreementResolution,
  resolveStatementOfDisagreement,
  statementOfDisagreementPublishedEvent,
} from "./statement-of-disagreement-consumer";
export {
  type EncounterPdfResolution,
  type EvvVerificationResolution,
  resolveEncounterPdfRender,
  resolveEvvVerificationRender,
} from "./evv-encounter-consumer";
