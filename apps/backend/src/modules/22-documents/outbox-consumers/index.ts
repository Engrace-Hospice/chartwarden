// apps/backend/src/modules/22-documents/outbox-consumers — M22-T06 the §4.11 outbox subscriptions +
// §4.12 disclosure gates. PHASE-1: pure decision core + real-seam resolvers ship; the live dispatcher
// binding is forward-declared/deferred (M6-T11 / M7-T08 precedent — this dir is not scanned by the
// arch:gaps event-catalog / seam-registry gates, so consuming `m6.*`/`m11.*`/… adds no edge; M22 deps
// stay `[1, 5]`).
export {
  M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS,
  M22_DOCUMENT_REQUEST_EVENTS,
  decideDocumentRequest,
  type DocumentRequestAction,
  type DocumentRequestEvent,
  type DocumentRequestFacts,
  type DocumentRequestPayload,
  type DocumentBackRef,
  type ExternalRecipientRef,
  type PlannedRender,
} from "./decide-document-request";
export {
  SUD_CONSENT_TYPE,
  resolveSudConsentPresent,
  type ConsentEvaluatorPort,
} from "./consent-gate";
export {
  resolveExternalBaaActive,
  type BaaStatusProviderPort,
} from "./baa-gate";
export {
  appealEnclosureIds,
  buildAppealPacketRenderGuard,
  type RenderGuardRefusal,
  type RenderGuardRequest,
} from "./appeal-render-guard";
export {
  M22_DOCUMENT_RENDER_CONSUMER,
  M22_DOCUMENT_REQUEST_BINDINGS,
  M22_DOCUMENT_REQUEST_BINDINGS_DEFERRED,
  type DocumentRequestBinding,
} from "./bindings";
export {
  MalformedRenderRequestError,
  buildM22DocumentRequestConsumer,
  normalizeDocumentRequest,
  type DocumentRequestConsumerDeps,
} from "./render-consumer";
