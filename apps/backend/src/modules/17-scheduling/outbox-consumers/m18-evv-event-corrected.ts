// apps/backend/src/modules/17-scheduling/outbox-consumers/m18-evv-event-corrected.ts — repoints a stale
// EVV provenance pointer after a correction-of-record (F-133 follow-up, #248).
//
// M18's own §2.2 D14 boundary text is explicit that M17's `visit.evv_check_in_event_id` /
// `evv_check_out_event_id` are "logical FKs to M18 — populated by M17's `evv-event.consumer` worker,
// never enforced cross-module by Postgres." `m18.evv.event_corrected` fires when a Clinical Supervisor+
// (step-up) supersedes an `evv_event` row (§2.3) — `evv_event_active_visit_kind_uidx` is a PARTIAL unique
// index `WHERE superseded_by_event_id IS NULL`, so the OLD event row still exists, just no longer active.
// If `visit.evv_check_in_event_id`/`evv_check_out_event_id` still names the SUPERSEDED id, M17's own
// provenance pointer is now wrong — pointing at a corrected-away record rather than the one M18 considers
// authoritative.
//
// M18's catalog DESCRIPTION for this event reads "M8/M17 re-read the bracket" — the identical phrase used
// for `m18.evv.check_in_recorded` et al., which F-140 (#248) correctly read as a SEAM-PULL description on
// the M8 side (M8's `EvvBracketResolver` re-derives the bracket fresh per call, so a push is redundant).
// That reading does NOT carry over to M17: unlike M8, M17 has no bracket-resolution seam consumed from
// M18 anywhere in this module (`grep`-confirmed — no `EvvBracketResolver`/reader import exists under
// `17-scheduling/`) — M17 does not "re-read" anything; it CACHES the pointer directly on the `visit` row
// at check-in/checkout time (the two consumers beside this file) and has no other path to it. So for M17
// specifically, "re-read the bracket" is not an accurate description of the real mechanism — the pointer
// is push-populated and push-corrected, or it silently goes stale forever. Nothing downstream currently
// READS these two columns (repo-wide grep confirms only the two write sites), so this is a provenance/
// audit-trail correctness fix, not a behavior-visible one today — but leaving a corrected-away event id
// on the visit's official record is exactly the kind of silent staleness this arc exists to close.
//
// Deliberately does NOT touch `evv_bracket_state`: the payload carries no new `gpsQuality`/
// `geofenceDecision`, so there is no honest basis to re-derive the bracket flag from this event alone —
// fabricating one would be the same mistake this arc's other findings refuse to make.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

const V = schema.visit;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M17_EVV_EVENT_CORRECTED_CONSUMER = {
  eventName: "m18.evv.event_corrected",
  consumerName: "m17.m18-evv-event-corrected",
} as const;

export interface EvvEventCorrectedDeps {
  readonly db: DbClient;
}

function factsOf(payload: unknown): {
  supersededEventId: string;
  newEventId: string;
  visitId: string;
} {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M17_EVV_EVENT_CORRECTED_CONSUMER.consumerName}: payload has no ${key}`);
    }
    return value;
  };
  return {
    supersededEventId: read("supersededEventId"),
    newEventId: read("newEventId"),
    visitId: read("visitId"),
  };
}

/**
 * M17's live `m18.evv.event_corrected` binding — repoints whichever of `evv_check_in_event_id` /
 * `evv_check_out_event_id` currently names the superseded event to the correction's new event id. At most
 * one of the two columns can match (the visit's check-in and check-out events are distinct rows), so at
 * most one UPDATE ever affects a row. Idempotent by construction: after the first correction, neither
 * column equals `supersededEventId` any more, so a redelivery matches zero rows on both attempts and is a
 * silent no-op.
 */
export function buildM17EvvEventCorrectedConsumer(deps: EvvEventCorrectedDeps) {
  return {
    consumerName: M17_EVV_EVENT_CORRECTED_CONSUMER.consumerName,
    consumerModule: "m17" as const,
    eventTypes: [M17_EVV_EVENT_CORRECTED_CONSUMER.eventName] as const,
    async handle(event: {
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

          const [correctedCheckIn] = await tx
            .update(V)
            .set({ evvCheckInEventId: facts.newEventId, updatedAt: new Date() })
            .where(
              and(eq(V.id, facts.visitId), eq(V.evvCheckInEventId, facts.supersededEventId)),
            )
            .returning({ id: V.id });
          if (correctedCheckIn) return;

          await tx
            .update(V)
            .set({ evvCheckOutEventId: facts.newEventId, updatedAt: new Date() })
            .where(
              and(eq(V.id, facts.visitId), eq(V.evvCheckOutEventId, facts.supersededEventId)),
            );
          // Zero rows on both attempts is a correct no-op (cross-tenant, visit not found, the pointer
          // never named the superseded event, or an already-applied redelivery) — nothing to detect.
        },
      );
    },
  };
}
