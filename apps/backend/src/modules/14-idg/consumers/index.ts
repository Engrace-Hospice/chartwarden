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
// `hope.j2051_trigger_fired` / `hope.sfv_created` exist (M10 Wave E). M22's `m22.document.rendered` lands
// later in THIS wave (M22) — the back-ref binding attaches when M22's renderer emits. Every consumed event
// name is a STRING literal (no cross-module schema import): M14 reads other modules solely through the
// foundation outbox, so this task adds NO new edge to M14's manifest `dependsOn` (§1.1).
import { type ActionItemEvent, transitionActionItem } from "@wardenx/idg";
import type { IdgActionItemLinkedKind } from "@wardenx/types";

/**
 * §4.5 D8 — the source events whose absorbing state auto-closes a linked `idg_action_item`, mapped to the
 * `linked_artifact_kind` the handler matches open items against. M7 `version_signed` closes
 * `care_plan_version` items (by `linked_artifact_id = signedVersionId`); M8 `encounter.signed` closes
 * `encounter` items (by `assigned_to_membership_id = signedByMembershipId`); M11 order signed/completed and
 * M12 medication-order signed/active close `order` / `medication_order` items.
 */
export const M14_AUTO_CLOSE_LINKED_KIND: Readonly<Record<string, IdgActionItemLinkedKind>> = {
  "m7.care_plan.version_signed": "care_plan_version",
  "m8.encounter.signed": "encounter",
  "m11.order.signed": "order",
  "m11.order.completed": "order",
  "m12.medication_order.signed": "medication_order",
  "m12.medication_order.active": "medication_order",
};

/** The pure D8 plan for one auto-close source event: the `linked_artifact_kind` to match open action items
 *  against + the absorbing-state `autoClose` event each matched item is transitioned with (which emits
 *  `m14.action_item.auto_closed`). Returns `null` for an event M14 does not auto-close on (defensive; the
 *  dispatcher only routes the mapped names here). The handler upserts on `(actionItemId, eventId)` so
 *  re-delivery is an idempotent no-op. */
export function planActionItemAutoClose(
  sourceEventName: string,
  linkedArtifactId: string,
): {
  readonly linkedArtifactKind: IdgActionItemLinkedKind;
  readonly event: ActionItemEvent;
} | null {
  const linkedArtifactKind = M14_AUTO_CLOSE_LINKED_KIND[sourceEventName];
  if (!linkedArtifactKind) return null;
  return {
    linkedArtifactKind,
    event: {
      type: "autoClose",
      linkedKind: linkedArtifactKind,
      linkedArtifactId,
      isSystemActor: true,
    },
  };
}

/** Re-export the pure absorbing-state engine the live handler runs per matched action item. */
export { transitionActionItem };

/** The §4.5 event → M14-consumer bindings. The live dispatcher wires each `eventName` to `consumerName`'s
 * handler at boot; the D8 auto-close path runs `planActionItemAutoClose` + `transitionActionItem`, the
 * projection-cache + back-ref paths run their Valkey/Drizzle effects. Consumer dedup is keyed on `(eventId,
 * consumerName)` per the M1 outbox-consumer pattern; re-delivery is safe. */
export const M14_OUTBOX_SUBSCRIPTIONS = [
  // inclusion-cache: which patients belong to a location's next scheduled meeting (§2.4 D1)
  { eventName: "m6.admission.activated", consumerName: "m14.m6-admission-activated" },
  { eventName: "m6.admission.discharged", consumerName: "m14.m6-admission-discharged" },
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
  { eventName: "hope.j2051_trigger_fired", consumerName: "m14.m10-j2051-trigger" },
  { eventName: "hope.sfv_created", consumerName: "m14.m10-sfv-created" },
  { eventName: "m11.order.discontinued", consumerName: "m14.m11-order-discontinued" },
  {
    eventName: "m12.medication_order.discontinued",
    consumerName: "m14.m12-medication-order-discontinued",
  },
  // M22 PDF render back-ref (§4.4 form-rendering handshake)
  { eventName: "m22.document.rendered", consumerName: "m14.m22-document-backref" },
] as const;
