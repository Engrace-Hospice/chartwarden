// apps/backend/src/modules/11-orders/consumers/index.ts — the M11 outbox-subscription surface (M11-T07,
// spec §4.5). Each entry binds an event another module emits to the M11 consumer that handles it; the
// PURE decision core for each ships + is tested here, and the live boot wiring (when the M11 backend is
// mounted) binds the handler to the dispatcher and executes the returned action through M11's service path.
//
// The producers for these three subscriptions (M6 discharge, M9 significant-change, M10 J2051) all exist
// in Wave E — these bindings are LIVE-eligible (not forward-declared deny-stubs like M8↔M17 / M6↔M29).
// What is deferred is only the dispatcher hookup at boot, which lands with the mounted backend. Every
// consumed event name is a STRING literal (no cross-module schema import): M11 reads other modules solely
// through the foundation outbox, never via a `dependsOn` edge (§4 boundary rule), so this task adds NO
// edge to M11's manifest `dependsOn`.
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
] as const;
