// apps/backend/src/modules/11-orders/consumers/index.ts — the M11 outbox-subscription surface (M11-T07,
// spec §4.5). Each entry binds an event another module emits to the M11 consumer that handles it; the
// PURE decision core for each ships + is tested here, and the live boot wiring (when the M11 backend is
// mounted) binds the handler to the dispatcher and executes the returned action through M11's service path.
//
// F-102 — `m6.admission.discharged` IS NOW BOUND (`./bindings.ts`). The paragraph below said the hookup
// "lands with the mounted backend"; the backend has been mounted for a long time and the hookup never
// landed, and it could not have: M6's catalog did not name m11 on that event, so
// `assertBindableAgainstCatalog` would have refused the binding. `m9.assessment.significant_change`,
// `m10.hope.j2051_trigger_fired` and `idg.decision_recorded` remain in that state and are registered with
// their reasons in `scripts/outbox-subscription-exceptions.ts`.
//
// The producers for these three subscriptions (M6 discharge, M9 significant-change, M10 J2051) all exist
// in Wave E — these bindings are LIVE-eligible (not forward-declared deny-stubs like M8↔M17 / M6↔M29).
// Every
// consumed event name is a STRING literal (no cross-module schema import): M11 reads other modules solely
// through the foundation outbox, never via a `dependsOn` edge (§4 boundary rule), so this task adds NO
// edge to M11's manifest `dependsOn`.
export {
  type OrdersConsumerDeps,
  M11_DISCHARGE_CASCADE_CONSUMER,
  buildM11DischargeCascadeConsumer,
} from "./bindings";
export {
  type AdmissionDischargedPayload,
  type DischargeCascadeAction,
  type DischargeCascadeFacts,
  type DischargeDiscontinueAction,
  type OrderOnAdmission,
  decideDischargeCascade,
} from "./admission-discharged-discontinue";
export {
  type SignificantChangePayload,
  decideAssessmentSuggestion,
} from "./assessment-trigger";
export {
  type HopeJ2051Severity,
  type HopeJ2051TriggerPayload,
  decideHopeSuggestion,
} from "./hope-trigger";
export type {
  OrderSuggestionEntry,
  SuggestionAction,
  SuggestionFacts,
  SuggestionSkipReason,
  SuggestionSource,
} from "./suggestion-banner";

/** The §4.5 event → M11-consumer bindings. The live dispatcher wires each `eventName` to `consumerName`'s
 * handler at boot; the pure decider each handler runs ships above. Names mirror the §3.1 package layout. */
export const M11_OUTBOX_SUBSCRIPTIONS = [
  { eventName: "m6.admission.discharged", consumerName: "m11.admission-discharged-discontinue" },
  { eventName: "m9.assessment.significant_change", consumerName: "m11.assessment-trigger" },
  { eventName: "m10.hope.j2051_trigger_fired", consumerName: "m11.hope-trigger" },
  { eventName: "idg.decision_recorded", consumerName: "m11.idg-decision-intake" },
  // F-095 — M11 BINDS this one live (`outbox-consumers/m22-document-rendered.ts`, the §7.2 W2 back-ref
  // that stamps `order_record.document_id`) and the catalog declares m11 on it, so it is delivered and
  // dispatched today. It was missing from this list for the whole of that binding's life: the list is
  // documented as the shared source of truth for the consumer wiring, and nothing compared it to either
  // the catalog or the bindings. Same shape as F-094's `idg.decision_recorded` in M16 — the one event a
  // module binds live that its own subscription list did not name.
  { eventName: "m22.document.rendered", consumerName: "m11.document-backref" },
] as const;
