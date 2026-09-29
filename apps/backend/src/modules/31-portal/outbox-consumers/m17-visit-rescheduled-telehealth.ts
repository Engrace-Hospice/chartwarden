// apps/backend/src/modules/31-portal/outbox-consumers/m17-visit-rescheduled-telehealth.ts — the §4.10
// `m17.visit.rescheduled` (telehealth-scoped) binding (F-139/#248's follow-up build).
//
// M31's own §4.10 table names this pair with a real, previously-unbuilt consumer file
// (`m17-visit-rescheduled-telehealth.ts`), effect: "Update room TTL or re-mint room if necessary."
//
// `m17.visit.rescheduled`'s catalogued payload (`events-by-m17.ts`) is `{visitId, rescheduledIntoVisitId,
// oldStartedAt, newStartedAt, reason}` — "a NEW visit row carries the new time" (the event's own
// description). `telehealth_visit` is keyed 1:1 on `m17_visit_id` (`telehealth_visit_m17_visit_unique`,
// §3.3), so there is no schema-legal way to move an EXISTING room row onto the new visit id — the room
// this event's OLD visit minted (if any) is now attached to a visit id that no longer represents a
// scheduled encounter. "Re-mint" in the spec's own gloss is therefore not a literal room replacement this
// consumer performs: it is what the (separately-scoped, not-yet-bound) `m17.visit.published` consumer
// already does for ANY newly-published visit — `rescheduledIntoVisitId` will itself fire its own
// `m17.visit.published` when M17 publishes it, and if that visit still carries the telehealth flag, THAT
// consumer mints the new room. This consumer's job is the half that actually belongs to the OLD visit: end
// the stale room so it cannot be joined once its visit no longer exists on the schedule — the identical
// force-end mechanics as `m17-visit-cancelled-telehealth.ts` (see that file's header for why the vendor
// force-end call is not attempted: no decrypt path exists anywhere in this codebase for
// `vendor_room_id_cipher`, confirmed against the one production route with the identical need).
//
// A visit with no telehealth room (the common case — most reschedules are non-telehealth) is the ordinary
// no-op: `telehealth_visit_m17_visit_unique` means nothing matches.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { TelehealthLifecycleState } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { canTransitionTelehealth } from "../telehealth/visit-lifecycle";

const TV = schema.telehealthVisits;

/** Mirrors the identical sentinel in the sibling `.cancelled` consumer — no actor column to stamp here. */
const CONSUMER_USER_ID = "";

export const M31_VISIT_RESCHEDULED_TELEHEALTH_CONSUMER = {
  eventName: "m17.visit.rescheduled",
  consumerName: "m31.m17-visit-rescheduled-telehealth",
} as const;

export interface VisitRescheduledTelehealthConsumerDeps {
  readonly db: DbClient;
}

function factsOf(payload: unknown): { oldVisitId: string; rescheduledIntoVisitId: string | null } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const oldVisitId = p.visitId;
  if (typeof oldVisitId !== "string" || oldVisitId.length === 0) {
    throw new Error(
      `${M31_VISIT_RESCHEDULED_TELEHEALTH_CONSUMER.consumerName}: payload has no visitId`,
    );
  }
  const rescheduledIntoVisitId =
    typeof p.rescheduledIntoVisitId === "string" && p.rescheduledIntoVisitId.length > 0
      ? p.rescheduledIntoVisitId
      : null;
  return { oldVisitId, rescheduledIntoVisitId };
}

/**
 * M31's live `m17.visit.rescheduled` binding. Idempotent: at most one `telehealth_visit` row can ever match
 * the OLD `visitId` (the unique index), and only a pre-ended row is touched — a redelivery, or a visit that
 * never had a telehealth room, finds nothing left to end.
 */
export function buildM31VisitRescheduledTelehealthConsumer(
  deps: VisitRescheduledTelehealthConsumerDeps,
) {
  return {
    consumerName: M31_VISIT_RESCHEDULED_TELEHEALTH_CONSUMER.consumerName,
    consumerModule: "m31" as const,
    eventTypes: [M31_VISIT_RESCHEDULED_TELEHEALTH_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const [row] = await tx
          .select({
            id: TV.id,
            lifecycleState: TV.lifecycleState,
            visitStartedAt: TV.visitStartedAt,
            version: TV.version,
          })
          .from(TV)
          .where(and(eq(TV.organizationId, organizationId), eq(TV.m17VisitId, facts.oldVisitId)))
          .limit(1);
        if (!row) return; // the OLD visit never had a telehealth room — nothing to end.

        const current = row.lifecycleState as TelehealthLifecycleState;
        if (!canTransitionTelehealth(current, "ended_aborted")) return; // already ended/reconciled.

        const startedMs = row.visitStartedAt ? row.visitStartedAt.getTime() : null;
        const now = new Date();

        await tx
          .update(TV)
          .set({
            lifecycleState: "ended_aborted",
            visitEndedAt: now,
            endReason: "other", // no `rescheduled` member exists on TelehealthEndReason (§3.3)
            totalDurationSec: startedMs ? Math.max(0, Math.round((now.getTime() - startedMs) / 1000)) : null,
            version: row.version + 1,
            updatedAt: now,
          })
          .where(and(eq(TV.id, row.id), eq(TV.version, row.version)));
      });
    },
  };
}
