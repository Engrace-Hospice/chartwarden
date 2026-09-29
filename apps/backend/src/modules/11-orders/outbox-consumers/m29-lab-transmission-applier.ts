// apps/backend/src/modules/11-orders/outbox-consumers/m29-lab-transmission-applier.ts — `LabTransmissionApplier`
// (D16, #248 F-177): M11's own consumer for the two real M29 outbound-HL7 lifecycle events, closing the m11
// group's `m29.lab_order.transmitted`/`.transmission_failed` pairs F-175 surfaced when it built M29's T08
// dispatch worker (M29 now genuinely publishes both; nothing on the M11 side read them until this file).
//
// D16 (locked, `docs/modules/WARDENX_MODULE_11_ORDERS_SPEC_v0_4.md` line ~2837) is decisive about the state
// machine: `order_record.transmission_status` moves `pending -> transmitted` on `m29.lab_order.transmitted`
// (`ackCode='AA'`), or to a terminal state on `m29.lab_order.transmission_failed`. Its own §4.10
// event-consumption table (line ~1498) is equally decisive on the events THIS file re-publishes: "Either way
// emit `m11.order.transmission_status_changed`" (i.e. on every transition, terminal included), and
// ADDITIONALLY `m11.order.transmission_terminal_failed` on the terminal one only (M36's high-severity
// ordering-provider alert).
//
// A REAL MISMATCH BETWEEN THE SPEC AND THE ACTUAL M29 PRODUCER (F-175), FLAGGED NOT PAPERED OVER. D16's own
// reference implementation gates the `failed` vs. `pending_retry` choice on a `willRetry` boolean it expects
// on the M29 payload. The REAL `LabOrderTransmissionFailedPayload`
// (`29-external-interfaces/outbound/outbound-events.ts`) carries NO such field — only
// `reason: "application_reject" | "dlq_exhausted"` — and F-175's own dispatch worker
// (`outbound/dispatch-worker.ts`'s `applyRetryDecision`) only ever publishes `m29.lab_order.transmission_failed`
// on DLQ exhaustion or an `AR` structural reject, NEVER for a retry-in-progress state (a non-terminal transport
// failure or a retryable `AE` ack just updates the `hl7_message_outbound` row and reschedules silently — no
// outbox event at all). So `pending_retry` (a real, already-migrated `order_transmission_status` enum value) is
// UNREACHABLE from this consumer as the real M29 contract stands today: every `m29.lab_order.transmission_failed`
// delivery this file will ever see is terminal, and is applied straight to `failed`. This is the CORRECT
// behavior for the actual producer, not a shortcut past the spec — if M29 later adds a genuine
// "still retrying" notification event, `pending_retry` becomes reachable and this file needs a third branch,
// not before.
//
// IDEMPOTENT BY DESIGN, NOT BY THROWING (the `m21-fulfillment-status.ts` precedent): the UPDATE is guarded by
// `transmissionStatus = <the status read just before it>`; a lost race (a redelivery, or two consumers racing
// the same order) is a benign no-op, never a re-publish. `transmitted` and `failed` are treated as already
// SETTLED — a redelivered M29 event against an already-`transmitted`/`failed` row silently skips (the D16 state
// machine has no transition out of either driven by this consumer).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { OrderWriteOutboxPort } from "../orders-route-service-db";
import { DISPATCH_REFUSED_PREFIX } from "../orm-request/orm-resend";

const ORDER = schema.orderRecords;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M11_LAB_TRANSMISSION_APPLIER_CONSUMER = {
  eventNames: [
    "m29.lab_order.transmitted",
    "m29.lab_order.transmission_failed",
    // F-187 — the worker's "wrote NO row" refusals; see `DispatchRefusedFacts`.
    "m29.lab_order.dispatch_refused",
  ] as const,
  consumerName: "m11.lab-transmission-applier",
} as const;

export interface LabTransmissionApplierDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m11.*` against the boot catalog. */
  readonly outbox: OrderWriteOutboxPort;
  readonly now?: () => Date;
}

interface TransmittedFacts {
  readonly kind: "transmitted";
  readonly orderId: string;
  readonly outboundMessageId: string;
  readonly ackReceivedAt: string;
}

interface TransmissionFailedFacts {
  readonly kind: "transmission_failed";
  readonly orderId: string;
  readonly outboundMessageId: string;
  readonly reason: "application_reject" | "dlq_exhausted";
  readonly attemptCount: number;
}

/**
 * F-187 — `m29.lab_order.dispatch_refused`: the worker could not persist ANY outbound row for the order (no /
 * ambiguous / unlinked feed, incomplete MSH identity on the feed, lapsed BAA). There is no `outboundMessageId`, so
 * the refusal's own id stands in as `sourceM29EventId`. Applied ONLY to an order still `pending` — a stale or
 * redelivered refusal never disturbs an order that has moved on.
 */
interface DispatchRefusedFacts {
  readonly kind: "dispatch_refused";
  readonly orderId: string;
  readonly refusalId: string;
  readonly reason: string;
}

function factsOf(
  eventType: string,
  payload: unknown,
): TransmittedFacts | TransmissionFailedFacts | DispatchRefusedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const orderId = p.orderId;
  const outboundMessageId = p.outboundMessageId;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new Error(`${M11_LAB_TRANSMISSION_APPLIER_CONSUMER.consumerName}: payload has no orderId`);
  }
  if (eventType === "m29.lab_order.dispatch_refused") {
    const refusalId = p.refusalId;
    const reason = p.reason;
    if (typeof refusalId !== "string" || refusalId.length === 0 || typeof reason !== "string" || reason.length === 0) {
      throw new Error(
        `${M11_LAB_TRANSMISSION_APPLIER_CONSUMER.consumerName}: dispatch_refused payload has no refusalId/reason`,
      );
    }
    return { kind: "dispatch_refused", orderId, refusalId, reason };
  }
  if (typeof outboundMessageId !== "string" || outboundMessageId.length === 0) {
    throw new Error(
      `${M11_LAB_TRANSMISSION_APPLIER_CONSUMER.consumerName}: payload has no outboundMessageId`,
    );
  }
  if (eventType === "m29.lab_order.transmitted") {
    const ackReceivedAt = p.ackReceivedAt;
    if (typeof ackReceivedAt !== "string" || ackReceivedAt.length === 0) {
      throw new Error(
        `${M11_LAB_TRANSMISSION_APPLIER_CONSUMER.consumerName}: transmitted payload has no ackReceivedAt`,
      );
    }
    return { kind: "transmitted", orderId, outboundMessageId, ackReceivedAt };
  }
  const reason = p.reason;
  if (reason !== "application_reject" && reason !== "dlq_exhausted") {
    throw new Error(
      `${M11_LAB_TRANSMISSION_APPLIER_CONSUMER.consumerName}: transmission_failed payload has an unrecognized reason`,
    );
  }
  const attemptCount = p.attemptCount;
  if (typeof attemptCount !== "number") {
    throw new Error(
      `${M11_LAB_TRANSMISSION_APPLIER_CONSUMER.consumerName}: transmission_failed payload has no attemptCount`,
    );
  }
  return { kind: "transmission_failed", orderId, outboundMessageId, reason, attemptCount };
}

export function buildM11LabTransmissionApplierConsumer(deps: LabTransmissionApplierDeps) {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M11_LAB_TRANSMISSION_APPLIER_CONSUMER.consumerName,
    consumerModule: "m11" as const,
    eventTypes: [...M11_LAB_TRANSMISSION_APPLIER_CONSUMER.eventNames],
    async handle(event: {
      readonly eventType: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.eventType, event.payload);
      const organizationId = event.organizationId;

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const [order] = await tx
          .select({
            id: ORDER.id,
            transmissionStatus: ORDER.transmissionStatus,
            orderingPhysicianMdmId: ORDER.orderingPhysicianMdmId,
          })
          .from(ORDER)
          .where(and(eq(ORDER.organizationId, organizationId), eq(ORDER.id, facts.orderId)))
          .limit(1);
        // No matching order (a cross-module id mismatch should never happen in practice, but the outbox
        // relay's at-least-once redelivery makes "already handled elsewhere, this row moved on" a real case
        // this consumer must treat as a benign no-op, not a throw that dead-letters a stale redelivery).
        if (!order) return;

        const fromStatus = order.transmissionStatus;
        // Terminal states never regress — see the file header's "idempotent by design" note.
        if (fromStatus === "transmitted" || fromStatus === "failed") return;
        // F-187 — a worker refusal only ever applies to an order still awaiting its first transmission.
        if (facts.kind === "dispatch_refused" && fromStatus !== "pending") return;

        const toStatus = facts.kind === "transmitted" ? "transmitted" : "failed";
        const failureReason =
          facts.kind === "dispatch_refused" ? `${DISPATCH_REFUSED_PREFIX}${facts.reason}` : facts.kind === "transmission_failed" ? facts.reason : null;
        const sourceM29EventId = facts.kind === "dispatch_refused" ? facts.refusalId : facts.outboundMessageId;
        const at = now();

        const updated = await tx
          .update(ORDER)
          .set(
            facts.kind === "transmitted"
              ? {
                  transmissionStatus: "transmitted" as const,
                  transmissionAckedAt: new Date(facts.ackReceivedAt),
                  transmissionAckCode: "AA",
                  transmissionFailureReason: null,
                  updatedAt: at,
                }
              : {
                  transmissionStatus: "failed" as const,
                  transmissionFailureReason: failureReason,
                  updatedAt: at,
                },
          )
          .where(
            and(
              eq(ORDER.organizationId, organizationId),
              eq(ORDER.id, order.id),
              eq(ORDER.transmissionStatus, fromStatus),
            ),
          )
          .returning({ id: ORDER.id });
        if (updated.length === 0) return; // lost a race to a concurrent redelivery

        // D16's own event-consumption table: "Either way emit `m11.order.transmission_status_changed`".
        await deps.outbox.publish(tx, {
          organizationId,
          eventName: "m11.order.transmission_status_changed",
          aggregateKind: "order",
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            organizationId,
            fromStatus,
            toStatus,
            ...(facts.kind === "transmitted" ? { ackCode: "AA" } : { failureReason: failureReason as string }),
            sourceM29EventId,
          },
        });

        if (facts.kind !== "transmitted") {
          await deps.outbox.publish(tx, {
            organizationId,
            eventName: "m11.order.transmission_terminal_failed",
            aggregateKind: "order",
            aggregateId: order.id,
            payload: {
              orderId: order.id,
              organizationId,
              failureReason: failureReason as string,
              // A refusal is by definition before any attempt: nothing was ever sent.
              transmittedAttempts: facts.kind === "transmission_failed" ? facts.attemptCount : 0,
              lastAttemptAt: at.toISOString(),
              orderingPhysicianMdmId: order.orderingPhysicianMdmId,
            },
          });
        }
      });
    },
  };
}
