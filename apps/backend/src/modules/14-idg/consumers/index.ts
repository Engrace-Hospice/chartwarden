// apps/backend/src/modules/14-idg/consumers/index.ts — the M14 outbox-subscription surface (M14-T06,
// spec §4.5). Each entry binds an event another module emits to the M14 consumer that handles it. Two effect
// shapes: (1) ACTION-ITEM AUTO-CLOSE (D8) — an M7/M8/M11/M12 absorbing-state event closes every open
// `idg_action_item` whose `linked_artifact_kind` matches the source; the pure `transitionActionItem(_,
// {type:'autoClose'})` engine in @wardenx/idg drives it (this file maps the source event → linked kind);
// (2) the per-patient "since last IDG" PROJECTION CACHE (Valkey, 30-day TTL) the M9/M10/M11/M12 events feed
// and the M22 PDF back-ref. The cache + Drizzle effects run in the live boot wiring when the M14 backend is
// mounted; the pure mapping ships + is testable here.
//
// The M6/M7/M8/M9/M11/M12 producers exist in Waves C–E — those bindings are LIVE-eligible. M10's
// `m10.hope.j2051_trigger_fired` / `m10.hope.sfv_created` exist (M10 Wave E). Both were written here
// WITHOUT the `m10.` prefix, and stayed that way (F-095): M10 catalogues them under the module-prefixed
// names every other event in the corpus uses, so these two named nothing. That is the exact failure this
// list's own header promises to prevent — "an upstream rename breaks the build rather than silently
// orphaning a handler" — and nothing compared the list to the catalog until rule 6 of
// `check-outbox-bindings.ts` did, so the J2051-trigger and SFV consumers pointed at names no module emits.
// M22's `m22.document.rendered` lands later in THIS wave (M22) — the back-ref binding attaches when
// M22's renderer emits. Every consumed event
// name is a STRING literal (no cross-module schema import): M14 reads other modules solely through the
// foundation outbox, so this task adds NO new edge to M14's manifest `dependsOn` (§1.1).
import { type ActionItemEvent, transitionActionItem } from "@wardenx/idg";
import type { IdgActionItemLinkedKind } from "@wardenx/types";

export {
  M14_AUTO_CLOSE_LINKED_KIND,
  planActionItemAutoClose,
} from "./action-item-auto-close";

/** Re-export the pure absorbing-state engine the live handler runs per matched action item. */
export { transitionActionItem };

/** F-104 — the LIVE binding that finally runs the D8 engine above. It is in a sibling file rather than
 *  here because this module is imported by the pure tests, and the binding pulls in Drizzle. */
export {
  type IdgAutoCloseConsumerDeps,
  M14_AUTO_CLOSE_CONSUMER,
  buildM14ActionItemAutoCloseConsumer,
} from "./bindings";

/** The §4.5 event → M14-consumer bindings. The live dispatcher wires each `eventName` to `consumerName`'s
 * handler at boot (F-104 — the six D8 auto-close entries ARE bound now, by `./bindings.ts`; the
 * inclusion-cache, projection-cache and M22 back-ref entries are not, and are registered with their
 * reasons in `scripts/outbox-subscription-exceptions.ts`); the D8 auto-close path runs
 * `planActionItemAutoClose` + `transitionActionItem`, the
 * projection-cache + back-ref paths run their Valkey/Drizzle effects. Consumer dedup is keyed on `(eventId,
 * consumerName)` per the M1 outbox-consumer pattern; re-delivery is safe. */
export const M14_OUTBOX_SUBSCRIPTIONS = [
  // F-176 (#248) — the two M6 inclusion-cache subscriptions (`m6.admission.activated`/`.discharged`) were removed:
  // D9 inclusion is answered by PULL at packet-build time (`idgPacketInclusionForOrg`, F-171), no cache exists.
  // D8 action-item auto-close (linked-artifact absorbing states)
  { eventName: "m7.care_plan.version_signed", consumerName: "m14.m7-version-signed" },
  { eventName: "m8.encounter.signed", consumerName: "m14.m8-encounter-signed" },
  { eventName: "m11.order.signed", consumerName: "m14.m11-order-signed" },
  { eventName: "m11.order.completed", consumerName: "m14.m11-order-signed" },
  { eventName: "m12.medication_order.signed", consumerName: "m14.m12-medication-order-signed" },
  { eventName: "m12.medication_order.active", consumerName: "m14.m12-medication-order-signed" },
  // "since last IDG" projection cache + flagged-events block
  { eventName: "m9.assessment.recorded", consumerName: "m14.m9-assessment-recorded" },
  { eventName: "m9.assessment.significant_change", consumerName: "m14.m9-significant-change" },
  { eventName: "m10.hope.j2051_trigger_fired", consumerName: "m14.m10-j2051-trigger" },
  { eventName: "m10.hope.sfv_created", consumerName: "m14.m10-sfv-created" },
  { eventName: "m11.order.discontinued", consumerName: "m14.m11-order-discontinued" },
  {
    eventName: "m12.medication_order.discontinued",
    consumerName: "m14.m12-medication-order-discontinued",
  },
  // M22 PDF render back-ref (§4.4 form-rendering handshake)
  { eventName: "m22.document.rendered", consumerName: "m14.m22-document-backref" },
] as const;
