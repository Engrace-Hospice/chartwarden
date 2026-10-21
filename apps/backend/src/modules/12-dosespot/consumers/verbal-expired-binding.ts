// apps/backend/src/modules/12-dosespot/consumers/verbal-expired-binding.ts — the live `OutboxConsumerBinding`
// for M12's §2.3 D3 verbal-order-expiry backref (M12-T08, spec §4.5).
//
// WHAT WAS MISSING, and why nothing could have caught it until now. `decideVerbalExpiry` (./verbal-expired.ts)
// has been a complete, pure, unit-tested decision core since M12-T08 with no caller anywhere but its own
// test; M11's `m11.order.verbal_expired_unsigned` catalog entry declared `m12` as a consumer (F-143, #248)
// with no `targetKind` field on the wire for this decider to discriminate on, and — the deepest layer —
// M11's OWN production `recordVerbal` write path never inserted the polymorphic `verbal_order` row for a
// medication-order target at all, so no deadline was ever stored for M12's verbal orders to expire against.
// All three are now real: M12's `recordVerbal` (`dosespot-route-service-db.ts`) records the receipt through
// M11's published `OrderSignatureProvider.recordVerbalOrder` seam; the catalog payload carries `targetKind`;
// and M11's `expireOverdueVerbals` (`orders-route-service-db.ts`, the `orders.verbal_timer` cron) scans the
// ONE polymorphic `verbal_order` table for both M11's own orders and M12's medication orders, per the
// module's own "why M12 has no parallel timer" design — this file is the M12-side half of that handshake.
//
// A `targetKind='order'` delivery (M11's own order expired, not a medication order) is not this consumer's
// concern at all and is skipped before any read — `decideVerbalExpiry` returns `not_medication_order`
// without consulting the row.
//
// `medication_order` carries NO dedicated `expired_at` timestamp column — checked against the schema rather
// than assumed, and M11's own `order_record` has none for this same terminal state either (it also just
// relies on `status` + `updated_at`, matching the STANDING platform convention: the pure machine's
// `set_timestamp field:'expired_at'` effect is a declarative wish list, not a mechanical execution contract
// — this module's other consumers (`bindings.ts`, `reconciliation-discontinue-binding.ts`) already apply
// only the subset of a decider's effects the real schema can back, and record so in their own headers).
// Adding a column nothing else needs, to satisfy an effect list nothing else here executes verbatim, would
// be new unreviewed schema for a fact `status='expired_unsigned'` + `updated_at` already records honestly.
//
// `userId` is empty — §3.3, a system transition records no actor. The read and the write are both
// M12-owned (`medication_order`) inside one `withOrgContext`. The consumed event name is a STRING literal
// and no M11 schema is imported, so this adds no `dependsOn` edge beyond the seam M12 already has.
import { type DbClient, schema } from "@chartwarden/db";
import { transitionMedicationOrder } from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import type { MedicationOrderStatus } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import {
  type VerbalExpiredFacts,
  type VerbalExpiredPayload,
  decideVerbalExpiry,
} from "./verbal-expired";

const MO = schema.medicationOrders;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** The event M12's verbal-expiry consumer subscribes to, and the `(eventId, consumerName)` receipt identity —
 *  already listed in `M12_OUTBOX_SUBSCRIPTIONS` (`consumers/index.ts`) pending exactly this factory. */
export const M12_VERBAL_EXPIRED_CONSUMER = {
  eventName: "m11.order.verbal_expired_unsigned",
  consumerName: "m12.verbal-expired",
} as const;

export interface VerbalExpiredConsumerDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s each payload against the boot catalog and rolls the tx back on a
   *  mismatch, so an invalid emit cannot leave an order flipped without its event. */
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly now?: () => Date;
}

function parsePayload(
  payload: unknown,
): { orderId: string; targetKind: string; expiredAt: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const orderId = p.orderId;
  const targetKind = p.targetKind;
  const expiredAt = p.expiredAt;
  if (typeof orderId !== "string" || orderId.length === 0) return null;
  if (typeof targetKind !== "string" || targetKind.length === 0) return null;
  if (typeof expiredAt !== "string" || expiredAt.length === 0) return null;
  return { orderId, targetKind, expiredAt };
}

/**
 * M12's live `m11.order.verbal_expired_unsigned` binding (§2.3 D3 / §4.5).
 *
 * Idempotent at two levels: the dispatcher's `(eventId, consumerName)` receipt, and — if a redelivery does
 * reach the handler — the target row is already `expired_unsigned` (or was resolved by a sign/discontinue
 * in the interim), which the decider / the version-guarded UPDATE both treat as a clean skip.
 */
export function buildM12VerbalExpiredConsumer(
  deps: VerbalExpiredConsumerDeps,
): OutboxConsumerBinding {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M12_VERBAL_EXPIRED_CONSUMER.consumerName,
    consumerModule: "m12",
    eventTypes: [M12_VERBAL_EXPIRED_CONSUMER.eventName],
    async handle(event): Promise<void> {
      const parsed = parsePayload(event.payload);
      if (parsed === null) {
        throw new Error(`${M12_VERBAL_EXPIRED_CONSUMER.consumerName}: malformed payload`);
      }
      // Not a medication-order target (M11's own `order_record` expired) — nothing for M12 to do, and no
      // point reading `medication_order` with an id that names a different table's row.
      if (parsed.targetKind !== "medication_order") return;

      const organizationId = event.organizationId;
      const decidePayload: VerbalExpiredPayload = {
        orderId: parsed.orderId,
        organizationId,
        targetKind: parsed.targetKind,
        expiredAt: parsed.expiredAt,
      };

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const [row] = await tx
            .select({ status: MO.status, patientId: MO.patientId, version: MO.version })
            .from(MO)
            .where(and(eq(MO.organizationId, organizationId), eq(MO.id, parsed.orderId)))
            .limit(1);

          const facts: VerbalExpiredFacts = row
            ? { status: row.status as MedicationOrderStatus, patientId: row.patientId }
            : { status: "draft" as MedicationOrderStatus, patientId: "" };
          const action = decideVerbalExpiry(decidePayload, facts);
          if (action.kind !== "expire" || !row) return;

          // Raises NOT_SYSTEM_ACTOR / VERBAL_DEADLINE_NOT_REACHED / ILLEGAL_MEDICATION_ORDER_TRANSITION
          // before anything is written — a status this decider did not expect dead-letters rather than
          // being silently reinterpreted.
          transitionMedicationOrder(row.status as MedicationOrderStatus, {
            type: "expire",
            isSystemActor: true,
            deadlineReached: true,
          });

          const at = now();
          // The `status` predicate is the concurrency guard between the read and the write: a clinician
          // signing this order in the gap moves it, the update matches nothing, and no event is emitted for
          // a row this delivery did not actually change.
          const updated = await tx
            .update(MO)
            .set({ status: "expired_unsigned", version: row.version + 1, updatedAt: at })
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
            eventName: "m12.medication_order.list_changed",
            organizationId,
            aggregateKind: "medication_order",
            aggregateId: action.orderId,
            payload: {
              patientId: action.patientId,
              addedOrderIds: [],
              removedOrderIds: [action.orderId],
            },
          });
        },
      );
    },
  };
}
