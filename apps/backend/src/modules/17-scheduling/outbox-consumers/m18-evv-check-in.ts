// apps/backend/src/modules/17-scheduling/outbox-consumers/m18-evv-check-in.ts — the D14 EVV-authoritative
// `published → en_route` advance (F-152, #248).
//
// M17's own D3/D14 spec calls EVV the AUTHORITATIVE driver of the visit lifecycle, and
// `@wardenx/scheduling`'s `transitionVisit` has supported an EVV-sourced `start` event
// (`VisitAdvanceSource: { via: "evv" }`) since the machine shipped — its own doc comment names
// `m18.evv.check_in_recorded` explicitly as one of the two events that "matched this visit (system
// actor)". Nothing ever bound it: the pair sat in `scripts/outbox-deferred-consumers.ts`'s m17
// `handlers-unbound` group. The route-layer equivalent (`SchedulingRouteService.startVisit`, the
// clinician self-attest path) already writes the identical shape — `status`, `evvBracketState`,
// `actualStartedAt`, the `visit_state_history` append, the `m17.visit.started` outbox — this consumer
// mirrors it exactly rather than inventing a second write path, with `cancelledByMembershipId`-style
// `null` in place of a staff membership (the F-102 `CONSUMER_USER_ID` convention).
//
// A NARROW GAP FOUND WHILE BINDING THIS, fixed here rather than left for later: `visit.evv_check_in_event_id`
// has existed on the schema since M17-T02 and NOTHING — not this consumer, not the HTTP self-attest route —
// has ever written it. The self-attest path has no `eventId` to write (there is no `evv_event` row on that
// path), which is presumably why the column was never wired there; THIS consumer does have one
// (`m18.evv.check_in_recorded`'s own `eventId`), so it is written here for the first time.
import { type DbClient, schema } from "@wardenx/db";
import { transitionVisit } from "@wardenx/scheduling";
import { withOrgContext } from "@wardenx/tenancy";
import type { VisitStatus } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

const V = schema.visit;
const VSH = schema.visitStateHistory;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M17_EVV_CHECK_IN_CONSUMER = {
  eventName: "m18.evv.check_in_recorded",
  consumerName: "m17.m18-evv-check-in",
} as const;

export interface M17EvvOutboxPort {
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

export interface EvvCheckInDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m17.*` against the boot catalog. */
  readonly outbox: M17EvvOutboxPort;
}

function factsOf(payload: unknown): { eventId: string; visitId: string; capturedAt: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M17_EVV_CHECK_IN_CONSUMER.consumerName}: payload has no ${key}`);
    }
    return value;
  };
  return { eventId: read("eventId"), visitId: read("visitId"), capturedAt: read("capturedAt") };
}

/**
 * M17's live `m18.evv.check_in_recorded` binding — the D14 EVV-authoritative `published → en_route`
 * advance. Idempotent by construction, the same shape `buildM17EncounterSignedConsumer` already uses one
 * file over: the UPDATE's WHERE clause pins `status = 'published'`, so a redelivery after the visit has
 * already advanced matches zero rows and is a silent no-op, never a second history row or a re-fired
 * `m17.visit.started`.
 */
export function buildM17EvvCheckInConsumer(deps: EvvCheckInDeps) {
  return {
    consumerName: M17_EVV_CHECK_IN_CONSUMER.consumerName,
    consumerModule: "m17" as const,
    eventTypes: [M17_EVV_CHECK_IN_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const [visit] = await tx
            .select({
              id: V.id,
              status: V.status,
              version: V.version,
              providerEntityId: V.providerEntityId,
              locationId: V.locationId,
            })
            .from(V)
            .where(eq(V.id, facts.visitId))
            .limit(1);
          if (!visit) return; // cross-tenant / already-erased — never a transition
          if (visit.status !== "published") return; // not eligible for `start`; idempotent no-op

          const transition = transitionVisit(visit.status as VisitStatus, {
            type: "start",
            source: { via: "evv" },
          });

          const [updated] = await tx
            .update(V)
            .set({
              status: transition.to,
              evvBracketState: "evv_present",
              evvCheckInEventId: facts.eventId,
              actualStartedAt: new Date(facts.capturedAt),
              version: visit.version + 1,
              updatedAt: new Date(),
            })
            .where(and(eq(V.id, facts.visitId), eq(V.status, "published")))
            .returning({ id: V.id });
          if (!updated) return;

          await tx.insert(VSH).values({
            organizationId,
            providerEntityId: visit.providerEntityId,
            locationId: visit.locationId,
            visitId: facts.visitId,
            fromState: "published",
            toState: "en_route",
            actorMembershipId: null,
            systemSource: "evv_check_in",
            reason: null,
            outboxEventId: event.id,
          });

          await deps.outbox.publish(tx, {
            eventName: "m17.visit.started",
            organizationId,
            aggregateKind: "visit",
            aggregateId: facts.visitId,
            payload: {
              visitId: facts.visitId,
              startedAt: facts.capturedAt,
              evvBracketState: "evv_present",
            },
          });
        },
      );
    },
  };
}
