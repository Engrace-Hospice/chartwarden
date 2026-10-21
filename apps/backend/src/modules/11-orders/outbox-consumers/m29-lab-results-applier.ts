// apps/backend/src/modules/11-orders/outbox-consumers/m29-lab-results-applier.ts — `LabResultsApplier`
// (GAP-016): M11's consumer for `m29.lab_observation.attached`, the other half of the M29 -> M11 lab handshake
// (the outbound half, `LabTransmissionApplier`, is `m29-lab-transmission-applier.ts`).
//
// WHAT WAS MISSING. M11 spec §4.10 (line ~1499) requires a `lab-results-applier` that, on a returned lab bound
// to an order, flips `order_record.results_status` to `results_received`, stamps `results_first_received_at`
// and `last_lab_observation_attached_id`, and emits `m11.order.results_received` (plus
// `m11.order.results_received_critical` on a critical flag). It did not exist. So `results_status` never left
// `awaiting_results`, `m11.order.results_received` had no emit site (M22's lab-results render and every other
// consumer of it read a dead event), the lab-results review queue was permanently empty, and the daily
// `lab-results-overdue-sweep` flipped every lab that HAD come back to `results_overdue` and alerted on it.
//
// THE REAL M29 PAYLOAD DIFFERS FROM THE SPEC'S REFERENCE SKETCH (flagged, not papered over). M29's
// `LabAttachedPayload` carries `{observationId, organizationId, patientId, orderRecordId | null, loincCode,
// abnormalFlag | null, observationDatetime}`: no `attachmentKind`, no `criticalFlags[]`, no `attachedAt`.
//   - `attachmentKind`: one `m29.lab_observation.attached` is one whole ORU report, so every attachment is
//     applied as `full` -> `results_received`. `partial_results_received` is reachable only once M29 says a
//     report is preliminary; until then nothing here can honestly decide it.
//   - critical: `abnormalFlag` is the observation's MOST SEVERE flag (`selectValueFlag`: critical > abnormal),
//     so `HH` / `LL` there is exactly M29's D7 "critical" set; it becomes the one-element `criticalFlags`.
//   - `results_first_received_at` is the consumer's receive instant (the payload carries only the clinical
//     `observationDatetime`, which is when the specimen was observed, not when WE received the result).
//
// IDEMPOTENT BY DESIGN: the UPDATE is guarded by `last_lab_observation_attached_id IS DISTINCT FROM <this
// observation>`, so a redelivery (or a second consumer racing) is a no-op that re-publishes nothing.
// An attachment with no `orderRecordId` (a result bound to a patient but no order) changes no order and is
// skipped; so is an id that names no lab order in this tenant.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import type { OrderWriteOutboxPort } from "../orders-route-service-db";

const ORDER = schema.orderRecords;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M11_LAB_RESULTS_APPLIER_CONSUMER = {
  eventNames: ["m29.lab_observation.attached"] as const,
  consumerName: "m11.lab-results-applier",
} as const;

/** M29's D7 critical set (`CRITICAL_FLAGS` in `29-external-interfaces/inbound/lab-abnormal.ts`): only these page. */
export const LAB_CRITICAL_ABNORMAL_FLAGS: ReadonlySet<string> = new Set(["HH", "LL"]);

export interface LabResultsApplierDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m11.*` against the boot catalog. */
  readonly outbox: OrderWriteOutboxPort;
  readonly now?: () => Date;
}

interface AttachedFacts {
  readonly observationId: string;
  readonly orderRecordId: string | null;
  readonly abnormalFlag: string | null;
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function factsOf(payload: unknown): AttachedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const observationId = nonEmptyString(p.observationId);
  if (observationId === null) {
    throw new Error(
      `${M11_LAB_RESULTS_APPLIER_CONSUMER.consumerName}: payload has no observationId`,
    );
  }
  return {
    observationId,
    orderRecordId: nonEmptyString(p.orderRecordId),
    abnormalFlag: nonEmptyString(p.abnormalFlag),
  };
}

export function buildM11LabResultsApplierConsumer(deps: LabResultsApplierDeps) {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M11_LAB_RESULTS_APPLIER_CONSUMER.consumerName,
    consumerModule: "m11" as const,
    eventTypes: [...M11_LAB_RESULTS_APPLIER_CONSUMER.eventNames],
    async handle(event: {
      readonly eventType: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      // A result bound to a patient but to no order changes no order's state.
      if (facts.orderRecordId === null) return;
      const orderId = facts.orderRecordId;
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const receivedAt = now();
          const updated = await tx
            .update(ORDER)
            .set({
              resultsStatus: "results_received",
              resultsFirstReceivedAt: sql`COALESCE(${ORDER.resultsFirstReceivedAt}, ${receivedAt.toISOString()}::timestamptz)`,
              lastLabObservationAttachedId: facts.observationId,
              updatedAt: receivedAt,
            })
            .where(
              and(
                eq(ORDER.organizationId, organizationId),
                eq(ORDER.id, orderId),
                eq(ORDER.kind, "lab"),
                // The idempotency floor: this observation is already the last one applied.
                sql`${ORDER.lastLabObservationAttachedId} IS DISTINCT FROM ${facts.observationId}::uuid`,
              ),
            )
            .returning({
              orderingPhysicianMdmId: ORDER.orderingPhysicianMdmId,
              signedAt: ORDER.signedAt,
            });
          // No such lab order in this tenant, or a redelivery of an observation already applied.
          const order = updated[0];
          if (!order) return;

          // The catalog requires both: a lab order that has been transmitted and has results was signed by
          // an ordering physician. Should a row ever lack either, the state change above stands and there
          // is no truthful payload to publish -- refuse to invent one.
          if (order.orderingPhysicianMdmId === null || order.signedAt === null) return;

          await deps.outbox.publish(tx, {
            organizationId,
            eventName: "m11.order.results_received",
            aggregateKind: "order",
            aggregateId: orderId,
            payload: {
              orderId,
              organizationId,
              observationId: facts.observationId,
              attachmentKind: "full",
              orderingPhysicianMdmId: order.orderingPhysicianMdmId,
              signedAt: order.signedAt.toISOString(),
            },
          });
          if (facts.abnormalFlag !== null && LAB_CRITICAL_ABNORMAL_FLAGS.has(facts.abnormalFlag)) {
            await deps.outbox.publish(tx, {
              organizationId,
              eventName: "m11.order.results_received_critical",
              aggregateKind: "order",
              aggregateId: orderId,
              payload: {
                orderId,
                organizationId,
                observationId: facts.observationId,
                criticalFlags: [facts.abnormalFlag],
                orderingPhysicianMdmId: order.orderingPhysicianMdmId,
              },
            });
          }
        },
      );
    },
  };
}
