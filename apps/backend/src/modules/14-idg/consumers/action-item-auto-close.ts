// apps/backend/src/modules/14-idg/consumers/action-item-auto-close.ts — the PURE §4.5 D8 mapping and
// planner. Split out of `./index.ts` (F-104) so `./bindings.ts` can import it without going through the
// barrel that re-exports the bindings — which `arch:boundaries` correctly reports as a cycle.
import type { ActionItemEvent } from "@wardenx/idg";
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
