// apps/backend/src/modules/12-dosespot/consumers/reconciliation-discontinue-binding.ts — the live
// `OutboxConsumerBinding` for M12's §2.8 D17 reconciliation "discontinue" handshake (F-155/F-161, #248).
//
// WHAT WAS MISSING. `m13.reconciliation.discontinue_requested` already declares `m12` as a consumer
// (`events-by-m13.ts`) and is already emitted by the real M13 write path (`emar-route-service-db.ts`'s
// `recordDecision`, on an M13-recorded `discontinue` decision against an `m12_active` reconciliation line)
// — `{worksheetId, decisionId, medicationOrderId, reason: "reconciled_discontinue"}`. Nothing on the M12
// side had ever consumed it: `M12_OUTBOX_SUBSCRIPTIONS` never listed it (unlike the discharge-cascade and
// verbal-expiry entries beside it), and `scripts/outbox-deferred-consumers.ts`'s `m12`/`handlers-unbound`
// group carried it as genuinely blocked, "no consumer file, no `triggering_reconciliation_decision_id`
// column anywhere in M12's schema" (F-155's own words). Re-checked for this pass: that column absence is
// real but not load-bearing — M12 already writes no discontinuation-provenance row on ANY path (see
// `./reconciliation-discontinue.ts`'s header), so the missing column blocks a nice-to-have idempotency key,
// not the write itself; idempotency is covered here the same way the discharge cascade covers it — by
// re-reading the row's CURRENT status before acting, which is already durable, atomic, and race-safe.
// A medication order M13 has decided to reconcile away stayed live indefinitely: still prescribable, still
// eligible for a refill, still `active` on the patient's chart, with no automatic way for the reconciliation
// decision that was ALREADY RECORDED (`medication_reconciliation_decision`) to ever reach the order itself.
//
// `userId` is empty — §3.3, a system transition records no actor (this is a consumer applying an already-
// recorded M13 clinical decision, not a human discontinuing the order directly). The read and the write are
// both M12-owned (`medication_order`) inside one `withOrgContext`; no cross-module seam read is needed
// (`medicationOrderId` is already the M12 primary key on the wire). The consumed event name is a STRING
// literal and no M13 schema is imported, so this adds no `dependsOn` edge.
import { type DbClient, schema } from "@wardenx/db";
import { transitionMedicationOrder } from "@wardenx/dosespot";
import { withOrgContext } from "@wardenx/tenancy";
import type { MedicationOrderStatus } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import {
  type ReconciliationDiscontinuePayload,
  decideReconciliationDiscontinue,
} from "./reconciliation-discontinue";

const MO = schema.medicationOrders;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** The event M12's reconciliation-discontinue consumer subscribes to, and the `(eventId, consumerName)`
 *  receipt identity. */
export const M12_RECONCILIATION_DISCONTINUE_CONSUMER = {
  eventName: "m13.reconciliation.discontinue_requested",
  consumerName: "m12.reconciliation-discontinue",
} as const;

export interface ReconciliationDiscontinueConsumerDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s each payload against the boot catalog and rolls the tx back on a
   *  mismatch, so an invalid emit cannot leave an order flipped without its event. */
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly now?: () => Date;
}

function parsePayload(payload: unknown): ReconciliationDiscontinuePayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const worksheetId = p.worksheetId;
  const decisionId = p.decisionId;
  const medicationOrderId = p.medicationOrderId;
  const reason = p.reason;
  if (
    typeof worksheetId !== "string" ||
    typeof decisionId !== "string" ||
    typeof medicationOrderId !== "string" ||
    medicationOrderId.length === 0 ||
    typeof reason !== "string" ||
    reason.length === 0
  )
    return null;
  return { worksheetId, decisionId, medicationOrderId, reason };
}

/**
 * M12's live `m13.reconciliation.discontinue_requested` binding (§2.8 D17 / §4.5).
 *
 * Idempotent at two levels: the dispatcher's `(eventId, consumerName)` receipt, and — if a redelivery does
 * reach the handler — the target row is already `discontinued`, which the decider counts as a clean skip.
 * A `medicationOrderId` naming no row under this org (wrong tenant, or genuinely absent) is also a no-op —
 * there is nothing this consumer can safely do with a fact it cannot verify.
 */
export function buildM12ReconciliationDiscontinueConsumer(
  deps: ReconciliationDiscontinueConsumerDeps,
): OutboxConsumerBinding {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M12_RECONCILIATION_DISCONTINUE_CONSUMER.consumerName,
    consumerModule: "m12",
    eventTypes: [M12_RECONCILIATION_DISCONTINUE_CONSUMER.eventName],
    async handle(event): Promise<void> {
      const payload = parsePayload(event.payload);
      if (payload === null) {
        throw new Error(
          `${M12_RECONCILIATION_DISCONTINUE_CONSUMER.consumerName}: malformed payload`,
        );
      }
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [row] = await tx
            .select({ id: MO.id, status: MO.status, version: MO.version })
            .from(MO)
            .where(
              and(eq(MO.organizationId, organizationId), eq(MO.id, payload.medicationOrderId)),
            )
            .limit(1);

          const action = decideReconciliationDiscontinue(
            payload,
            row ? { status: row.status as MedicationOrderStatus } : null,
          );
          if (action.kind !== "discontinue" || !row) return;

          // Raises NOT_SYSTEM_ACTOR / ILLEGAL_MEDICATION_ORDER_TRANSITION before anything is written — a
          // status `cascadeDiscontinue` cannot legally leave (draft/signed/transmitted/ack_received/
          // nack_received/completed/transmission_failed) dead-letters rather than being reinterpreted.
          transitionMedicationOrder(row.status as MedicationOrderStatus, {
            type: "cascadeDiscontinue",
            isSystemActor: true,
          });

          const at = now();
          // The `status` predicate is the concurrency guard between the read and the write: a clinician or
          // another consumer moving this order in the gap makes the update match nothing, and no event is
          // emitted for a row this decision did not actually change.
          const updated = await tx
            .update(MO)
            .set({
              status: "discontinued",
              discontinuedAt: at,
              version: row.version + 1,
              updatedAt: at,
            })
            .where(
              and(
                eq(MO.organizationId, organizationId),
                eq(MO.id, action.orderId),
                eq(MO.status, row.status),
              ),
            )
            .returning({ id: MO.id });
          if (updated.length === 0) return;

          await deps.outbox.publish(tx, {
            eventName: "m12.medication_order.discontinued",
            organizationId,
            aggregateKind: "medication_order",
            aggregateId: action.orderId,
            payload: {
              orderId: action.orderId,
              reason: action.reason,
              actorMembershipId: null,
              effectiveAt: at.toISOString(),
            },
          });
        },
      );
    },
  };
}
