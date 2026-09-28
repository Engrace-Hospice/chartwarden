// apps/backend/src/modules/17-scheduling/outbox-consumers/m20-safety-visit-cancellation.ts — the §7.5
// SOS-resolution visit cancellation (F-152, #248).
//
// M20's own catalog entry for `m20.safety.visit_cancellation_requested` says outright: "M20 never writes
// an M17 row — this event IS the request and M17's D3 handler decides." The pair sat in
// `scripts/outbox-deferred-consumers.ts`'s m17 `handlers-unbound` group with no such handler ever built.
// Mirrors `SchedulingRouteService.cancelVisit`'s write shape exactly (the machine's `cancel` event, the
// `visit_state_history` append, the `m17.visit.unassigned` + `m17.visit.cancelled` outbox pair), with one
// deliberate departure: `cancellationReasonCode: "sos_alert_resolved"` in place of `cancelVisit`'s generic
// `"operational"`, so a supervisor reviewing the cancellation audit trail sees WHY rather than a catch-all
// code — the SOS alert id is carried in the free-text reason for the same purpose.
//
// ACTOR ATTRIBUTION: NOT the F-102 null-membership convention M16/M30 use — `m17.visit.cancelled`'s own
// catalogued payload requires `cancelledBy` as a non-empty string (`Type.String({minLength: 1})`,
// `events-by-m17.ts`), so a consumer-driven cancellation cannot leave it null the way a nullable DB column
// can. `consumers/admission-lifecycle.ts` and `consumers/care-plan-proposals.ts` already solved this
// exact problem for M17's other two system-driven write paths with a well-known system-membership
// sentinel (`M17_SYSTEM_USER_ID`, not a real membership row — `cancelled_by_membership_id`/
// `visit_state_history.actor_membership_id` are both plain app-validated uuid columns with no FK); this
// consumer reuses the identical constant and the identical `cancelledByMembershipId: userId || null`
// shape `cancelFuturePublishedVisitsForAdmission` already established, rather than inventing a third
// system-actor convention in the same module.
import { type DbClient, schema } from "@wardenx/db";
import { transitionVisit } from "@wardenx/scheduling";
import { withOrgContext } from "@wardenx/tenancy";
import type { VisitStatus } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

const V = schema.visit;
const VSH = schema.visitStateHistory;

/** Mirrors `consumers/admission-lifecycle.ts`'s / `consumers/care-plan-proposals.ts`'s identical constant —
 *  M17's own established system-actor sentinel, not a real membership row (both target columns are plain
 *  app-validated uuid with no FK). Duplicated locally rather than imported because neither sibling file
 *  exports it (the existing pattern in this module). */
const M17_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000017";

export const M17_SOS_VISIT_CANCELLATION_CONSUMER = {
  eventName: "m20.safety.visit_cancellation_requested",
  consumerName: "m17.m20-safety-visit-cancellation",
} as const;

export interface M17SosCancelOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface SosVisitCancellationDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m17.*` against the boot catalog. */
  readonly outbox: M17SosCancelOutboxPort;
}

function factsOf(payload: unknown): { sosAlertId: string; visitId: string; requestedAt: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `${M17_SOS_VISIT_CANCELLATION_CONSUMER.consumerName}: payload has no ${key}`,
      );
    }
    return value;
  };
  return {
    sosAlertId: read("sosAlertId"),
    visitId: read("visitId"),
    requestedAt: read("requestedAt"),
  };
}

/**
 * M17's live `m20.safety.visit_cancellation_requested` binding. Idempotent by construction:
 * `transitionVisit`'s own `VISIT_GRAPH` only accepts `cancel` from `published`/`en_route`/`in_visit`, so a
 * redelivery against an already-cancelled (or otherwise terminal) visit hits the `isCancellable` guard
 * below and is a silent no-op, never a second history row or a re-fired `m17.visit.cancelled`.
 */
export function buildM17SosVisitCancellationConsumer(deps: SosVisitCancellationDeps) {
  return {
    consumerName: M17_SOS_VISIT_CANCELLATION_CONSUMER.consumerName,
    consumerModule: "m17" as const,
    eventTypes: [M17_SOS_VISIT_CANCELLATION_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: "" },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const [visit] = await tx
            .select({
              id: V.id,
              status: V.status,
              version: V.version,
              providerEntityId: V.providerEntityId,
              locationId: V.locationId,
              patientId: V.patientId,
              assignedMembershipId: V.assignedMembershipId,
            })
            .from(V)
            .where(eq(V.id, facts.visitId))
            .limit(1);
          if (!visit) return;

          const isCancellable =
            visit.status === "published" ||
            visit.status === "en_route" ||
            visit.status === "in_visit";
          if (!isCancellable) return; // already terminal — idempotent no-op

          const reason = `SOS alert ${facts.sosAlertId} resolved with outcome=visit_cancelled (§7.5)`;
          const transition = transitionVisit(visit.status as VisitStatus, {
            type: "cancel",
            reason,
            cancelledByPresent: true,
          });

          const [updated] = await tx
            .update(V)
            .set({
              status: transition.to,
              cancelledByMembershipId: M17_SYSTEM_USER_ID,
              cancelledAt: new Date(facts.requestedAt),
              cancellationReason: reason,
              cancellationReasonCode: "sos_alert_resolved",
              version: visit.version + 1,
              updatedAt: new Date(),
            })
            .where(and(eq(V.id, facts.visitId), eq(V.status, visit.status as VisitStatus)))
            .returning({ id: V.id });
          if (!updated) return;

          await tx.insert(VSH).values({
            organizationId,
            providerEntityId: visit.providerEntityId,
            locationId: visit.locationId,
            visitId: facts.visitId,
            fromState: visit.status as VisitStatus,
            toState: "cancelled",
            actorMembershipId: M17_SYSTEM_USER_ID,
            systemSource: "sos_visit_cancellation",
            reason,
            outboxEventId: null,
          });

          await deps.outbox.publish(tx, {
            eventName: "m17.visit.unassigned",
            organizationId,
            aggregateKind: "visit",
            aggregateId: facts.visitId,
            payload: {
              visitId: facts.visitId,
              formerAssignedMembershipId: visit.assignedMembershipId,
              patientId: visit.patientId,
            },
          });
          await deps.outbox.publish(tx, {
            eventName: "m17.visit.cancelled",
            organizationId,
            aggregateKind: "visit",
            aggregateId: facts.visitId,
            payload: {
              visitId: facts.visitId,
              cancelledBy: M17_SYSTEM_USER_ID,
              reason,
              reasonCode: "sos_alert_resolved",
            },
          });
        },
      );
    },
  };
}
