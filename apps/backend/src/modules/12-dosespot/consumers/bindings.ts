// apps/backend/src/modules/12-dosespot/consumers/bindings.ts — the live `OutboxConsumerBinding` for M12's
// §2.2 D13 discharge cascade (F-102 / #103).
//
// WHAT WAS MISSING, and why it is worse here than in M11. `decideMedicationDischargeCascade` beside this
// file was complete, exported and unit-tested since M12-T08, and its only caller was its own test; M12 was
// not in `m6.admission.discharged`'s `declaredConsumers`, so nothing could have bound it even if someone
// had written the factory. Every medication order in flight when a patient was discharged stayed in flight
// forever — including a `queued_for_transmission` order, which is one waiting to be sent to the
// e-prescribing vendor. A discharged patient's controlled-substance order does not stop being prescribable
// because the admission ended.
//
// ── WHY NOT `discontinueOrder` ────────────────────────────────────────────────────────────────────────
//
// The same reason as M11's sibling binding, plus one of M12's own:
//
//   • `discontinueOrder` writes `actorMembershipId: userId` — the caller. §4.5 requires NULL for a system
//     cascade, and attributing a system discontinuation to whoever happened to be on the request would put
//     a clinician's name on an act they did not perform.
//   • It runs the machine's `discontinue` event. `cascadeDiscontinue` is legal from `pending_signature`,
//     `epcs_identity_pending` and `queued_for_transmission` as well as `active`; the human event is not, so
//     the orders that most need stopping are exactly the ones it would have refused.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────────────────────────────────
//
// The machine's effect list includes `write_discontinuation`, and M12 writes no discontinuation row: the
// ledger is M11's `order_discontinuation` (migration 0156 added the `target_kind='medication_order'`
// discriminator for exactly this), M11 owns that table, and M12 reaches it only through the §2.8 D14 seam.
// M12's own `discontinueOrder` route path drops the same effect. That gap is real and pre-existing on BOTH
// paths, and it is left alone here on purpose: making the cascade write a ledger row the human route does
// not would mean a discharged patient's chart shows provenance a clinician-discontinued order does not,
// which is a worse inconsistency than the one it fixes. Reported, not taken.
//
// `userId` is empty — §3.3, a system transition records no actor. The read and the write are M12-owned
// tables inside one `withOrgContext`. The consumed event name is a STRING literal and no M6 schema is
// imported, so this adds no `dependsOn` edge.
import { type DbClient, schema } from "@chartwarden/db";
import { transitionMedicationOrder } from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import type { MedicationOrderStatus } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import {
  type MedicationOrderOnAdmission,
  decideMedicationDischargeCascade,
} from "./admission-discharged-cascade";

const MO = schema.medicationOrders;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** The event M12's discharge cascade consumes, and the `(eventId, consumerName)` receipt identity. */
export const M12_DISCHARGE_CASCADE_CONSUMER = {
  eventName: "m6.admission.discharged",
  consumerName: "m12.admission-discharged-cascade",
} as const;

/** Read-side narrowing; {@link decideMedicationDischargeCascade} is still the authority (an agreement case
 *  in `dosespot-consumers.test.ts` keeps the two sets in step). */
const IN_FLIGHT: readonly MedicationOrderStatus[] = [
  "pending_signature",
  "verbal_pending",
  "queued_for_transmission",
  "active",
];

export interface DoseSpotConsumerDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s each payload against the boot catalog and rolls the tx back on a
   *  mismatch, so an invalid emit cannot leave an order flipped without its event. */
  readonly outbox: DoseSpotWriteOutboxPort;
  readonly now?: () => Date;
}

function admissionIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as { readonly admissionId?: unknown }).admissionId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * M12's live `m6.admission.discharged` binding (§2.2 D13 / §4.5).
 *
 * Idempotent at two levels: the dispatcher's `(eventId, consumerName)` receipt, and — if a redelivery does
 * reach the handler — every order is already `discontinued`, which the decider counts as skipped.
 */
export function buildM12DischargeCascadeConsumer(
  deps: DoseSpotConsumerDeps,
): OutboxConsumerBinding {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M12_DISCHARGE_CASCADE_CONSUMER.consumerName,
    consumerModule: "m12",
    eventTypes: [M12_DISCHARGE_CASCADE_CONSUMER.eventName],
    async handle(event): Promise<void> {
      const admissionId = admissionIdOf(event.payload);
      if (admissionId === null) {
        throw new Error(
          `${M12_DISCHARGE_CASCADE_CONSUMER.consumerName}: payload has no admissionId`,
        );
      }
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const rows = await tx
            .select({ id: MO.id, status: MO.status, version: MO.version })
            .from(MO)
            .where(
              and(
                eq(MO.organizationId, organizationId),
                eq(MO.admissionId, admissionId),
                inArray(MO.status, IN_FLIGHT),
              ),
            );
          const ordersOnAdmission: MedicationOrderOnAdmission[] = rows.map((r) => ({
            orderId: r.id,
            status: r.status as MedicationOrderStatus,
          }));

          const action = decideMedicationDischargeCascade(
            { admissionId, organizationId, dischargeEventId: event.id },
            { ordersOnAdmission },
          );
          const byId = new Map(rows.map((r) => [r.id, r]));
          const at = now();

          for (const d of action.discontinuations) {
            const row = byId.get(d.orderId);
            if (!row) continue;
            // Raises NOT_SYSTEM_ACTOR / ILLEGAL_MEDICATION_ORDER_TRANSITION before anything is written.
            transitionMedicationOrder(row.status as MedicationOrderStatus, {
              type: "cascadeDiscontinue",
              isSystemActor: true,
            });
            // The `status` predicate is the concurrency guard between the read and the write: a clinician
            // signing this order in the gap moves it, the update matches nothing, and no event is emitted
            // for a row the cascade did not change.
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
                  eq(MO.id, d.orderId),
                  eq(MO.status, row.status),
                ),
              )
              .returning({ id: MO.id });
            if (updated.length === 0) continue;

            await deps.outbox.publish(tx, {
              eventName: "m12.medication_order.discontinued",
              organizationId,
              aggregateKind: "medication_order",
              aggregateId: d.orderId,
              payload: {
                orderId: d.orderId,
                reason: d.reason,
                actorMembershipId: d.actorMembershipId,
                effectiveAt: at.toISOString(),
              },
            });
          }
        },
      );
    },
  };
}
