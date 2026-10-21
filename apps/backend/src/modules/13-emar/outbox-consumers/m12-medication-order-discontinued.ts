import { type DbClient, schema } from "@chartwarden/db";
// apps/backend/src/modules/13-emar/outbox-consumers/m12-medication-order-discontinued.ts — the
// order-level scheduled-dose cascade, live for the first time (F-166, #248).
//
// `planOrderDiscontinueCascade` (`@chartwarden/emar`, `cascade/order-discontinue-cascade.ts`) is the
// order-scoped counterpart to `planDischargeCascade` (F-155's admission-level D14 cascade): a
// `discontinueOrder` (or the discharge/discontinue cascades acting through it) flips ONE order to
// `discontinued`, and every future PENDING scheduled dose for THAT order — not the whole admission,
// which may carry other still-active orders — is stale the instant it stops.
// `M13_OUTBOX_SUBSCRIPTIONS` (`consumers/index.ts`) has named `m12.medication_order.discontinued` with a
// real consumer (`m13.cancel-future-schedule`) since the list was written; nothing has ever bound it.
//
// NO CROSS-MODULE READ NEEDED. The catalogued payload (`events-by-m12.ts`) already carries
// `{orderId, reason, actorMembershipId, effectiveAt}` — `effectiveAt` is exactly the cascade's cutoff
// instant, so unlike the discharge cascade (which needs M6's `patientId` for its `m13.comfort_kit.
// return_required` payload) this consumer reads only M13's own `scheduled_dose` table.
//
// IDEMPOTENCY WITHOUT A VERSION COLUMN. `scheduled_dose` carries no `version` column, so the UPDATE
// conditions its `WHERE` on the SAME `status = 'pending'` predicate the SELECT used to find candidates
// (the `m6-admission-discharged-cascade.ts` precedent for the identical table) — a lost race, or a
// redelivery after the first delivery committed, matches zero rows and is a silent no-op, never a
// double-cancellation.
//
// A consumer-driven write names no acting membership: `scheduled_dose` has no actor column for this
// transition (the discharge cascade's own header notes the same for this table).
import { planOrderDiscontinueCascade } from "@chartwarden/emar";
import { withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant } from "@chartwarden/types";
import { and, eq, gt } from "drizzle-orm";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";

const SD = schema.scheduledDoses;

export const M13_CANCEL_FUTURE_SCHEDULE_CONSUMER = {
  eventName: "m12.medication_order.discontinued",
  consumerName: "m13.cancel-future-schedule",
} as const;

export interface CancelFutureScheduleConsumerDeps {
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
}

function factsOf(payload: unknown): { orderId: string; effectiveAt: IsoInstant } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const orderId = p.orderId;
  const effectiveAt = p.effectiveAt;
  if (typeof orderId !== "string" || orderId.length === 0) {
    throw new Error(`${M13_CANCEL_FUTURE_SCHEDULE_CONSUMER.consumerName}: payload has no orderId`);
  }
  if (typeof effectiveAt !== "string" || effectiveAt.length === 0) {
    throw new Error(
      `${M13_CANCEL_FUTURE_SCHEDULE_CONSUMER.consumerName}: payload has no effectiveAt`,
    );
  }
  return { orderId, effectiveAt: effectiveAt as IsoInstant };
}

/**
 * M13's live `m12.medication_order.discontinued` binding. Cancels every future pending scheduled dose
 * for the discontinued order (never retroactive — a past due-at dose either has an administration or the
 * missed-dose sweep owns it).
 */
export function buildM13CancelFutureScheduleConsumer(deps: CancelFutureScheduleConsumerDeps) {
  return {
    consumerName: M13_CANCEL_FUTURE_SCHEDULE_CONSUMER.consumerName,
    consumerModule: "m13" as const,
    eventTypes: [M13_CANCEL_FUTURE_SCHEDULE_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const candidateDoses = await tx
          .select({ id: SD.id, dueAt: SD.dueAt, status: SD.status })
          .from(SD)
          .where(
            and(
              eq(SD.organizationId, organizationId),
              eq(SD.medicationOrderId, facts.orderId),
              eq(SD.status, "pending"),
              gt(SD.dueAt, new Date(facts.effectiveAt)),
            ),
          );

        const plan = planOrderDiscontinueCascade({
          medicationOrderId: facts.orderId,
          effectiveAt: facts.effectiveAt,
          sourceEventId: event.id,
          scheduledDoses: candidateDoses.map((d) => ({
            scheduledDoseId: d.id,
            dueAt: d.dueAt.toISOString(),
            status: d.status,
          })),
        });

        for (const cancellation of plan) {
          const [updated] = await tx
            .update(SD)
            .set({
              status: "cancelled",
              cancellationReason: cancellation.cancellationReason,
              cancellationSourceEventId: cancellation.sourceEventId,
              cancelledAt: new Date(),
            })
            .where(and(eq(SD.id, cancellation.scheduledDoseId), eq(SD.status, "pending")))
            .returning({ id: SD.id });
          if (!updated) continue; // lost a race, or already cancelled by a redelivery — no-op
          await deps.outbox.publish(tx, {
            eventName: "m13.scheduled_dose.cancelled",
            organizationId,
            aggregateKind: "scheduled_dose",
            aggregateId: cancellation.scheduledDoseId,
            payload: {
              scheduledDoseId: cancellation.scheduledDoseId,
              medicationOrderId: cancellation.medicationOrderId,
              cancellationReason: cancellation.cancellationReason,
              sourceEventId: cancellation.sourceEventId,
            },
          });
        }
      });
    },
  };
}
