// apps/backend/src/modules/22-documents/consumers/index.ts — the M22 outbox-subscription surface (M22-T06,
// spec §4.11). Each entry binds a `*.document_requested`-family event another module emits to the M22 consumer
// that renders the document and emits the `m22.document.rendered` back-ref. The PURE decision core for the whole
// surface ships in {@link planDocumentRender} / {@link dispatchDocumentRender} (./document-requested); the live
// boot wiring (M22-T07) binds each `eventName` to `consumerName`'s handler on the M1 dispatcher and runs the
// render through M22's published `DocumentRenderer` seam.
//
// Every consumed event name is a STRING literal (no cross-module schema import). M22 reads other modules solely
// through the foundation outbox + the `@wardenx/forms` library it OWNS, so this task adds NO new edge to M22's
// manifest `dependsOn` (`[1, 5]`). Consumer dedup is keyed on `(eventId, consumerName)` per the M1 outbox-consumer
// pattern; re-delivery is an idempotent no-op (a re-render of the same aggregate appends a version, never a new
// document — W2). Producers in Waves C–E (M5/M6/M8/M11/M12/M13) are LIVE-eligible; M14/M16/M17/M18 land in THIS
// wave; M23 (`abn`) stays an inert forward producer until M23 lands; M39 consent is LIVE (Wave F).
export {
  type DocumentRenderPlan,
  type DocumentRenderPort,
  type RenderedBackRefEvent,
  M22_DOCUMENT_REQUESTED_BINDINGS,
  dispatchDocumentRender,
  planDocumentRender,
} from "./document-requested";

/** The §4.11 event → M22-consumer bindings. The live dispatcher wires each `eventName` to `consumerName`'s
 * handler at boot; every handler runs `planDocumentRender` + `dispatchDocumentRender` over M22's `DocumentRenderer`
 * seam. Names mirror the §4.5 Form Template Library source modules (the render handshake, §7.2 W2). */
export const M22_OUTBOX_SUBSCRIPTIONS = [
  // M5 — amendment statement of disagreement (§7.5 W5)
  { eventName: "m5.patient.amendment_decided", consumerName: "m22.m5-amendment-render" },
  // M6 — election / certification / discharge (D21 external-source variant branch)
  { eventName: "m6.election.signed", consumerName: "m22.m6-document-requested" },
  { eventName: "m6.cti.signed", consumerName: "m22.m6-document-requested" },
  { eventName: "m6.f2f.attested", consumerName: "m22.m6-document-requested" },
  { eventName: "m6.nor.acknowledged", consumerName: "m22.m6-document-requested" },
  { eventName: "m6.revocation.created", consumerName: "m22.m6-document-requested" },
  { eventName: "m6.discharge.created", consumerName: "m22.m6-document-requested" },
  { eventName: "m6.discharge.cosigned", consumerName: "m22.m6-document-requested" },
  { eventName: "m6.transfer.created", consumerName: "m22.m6-document-requested" },
  // M8 — encounter (signed + addendum → new version on the same document, W2)
  { eventName: "m8.encounter.signed", consumerName: "m22.m8-encounter-document-requested" },
  { eventName: "m8.encounter.addendum_signed", consumerName: "m22.m8-encounter-document-requested" },
  // M11 — orders + lab results (D20 SUD redaction, D22 critical, D23 retention)
  { eventName: "m11.order.document_requested", consumerName: "m22.m11-order-document-requested" },
  { eventName: "m11.order.results_received", consumerName: "m22.m11-order-results-received" },
  { eventName: "m11.order.results_received_critical", consumerName: "m22.m11-order-results-received-critical" },
  // M12 — medication order + medication list
  { eventName: "m12.medication_order.document_requested", consumerName: "m22.m12-medication-order-document-requested" },
  { eventName: "m12.medication_order.list_changed", consumerName: "m22.m12-medication-order-document-requested" },
  // M13 — eMAR reconciliation worksheet
  { eventName: "m13.reconciliation.finalized", consumerName: "m22.m13-emar-document-requested" },
  // M14 — IDG packet + minutes
  { eventName: "m14.packet.render_requested", consumerName: "m22.m14-idg-document-requested" },
  { eventName: "m14.minutes.signed", consumerName: "m22.m14-idg-document-requested" },
  // M15 — discipline care plans (kind-discriminated single event)
  { eventName: "m15.plan.version_signed", consumerName: "m22.m15-discipline-plan-document-requested" },
  // M16 — bereavement letters (letterKind sub-layout)
  { eventName: "m16.bereavement.outreach_artifact_requested", consumerName: "m22.m16-bereavement-letter-render" },
  { eventName: "bereavement.anniversary_due", consumerName: "m22.m16-bereavement-letter-render" },
  // M17 — visit confirmation; M18 — EVV verification
  { eventName: "m17.visit.scheduled", consumerName: "m22.m17-visit-confirmation-render" },
  { eventName: "m18.evv.aggregator_accepted", consumerName: "m22.m18-evv-verification-render" },
  // M23 — ABN (forward producer, inert until M23 lands); M39 — consent (LIVE)
  { eventName: "m23.abn.required", consumerName: "m22.m23-abn-render" },
  { eventName: "m39.consent.signed", consumerName: "m22.m39-consent-document-render" },
] as const;
