// apps/backend/src/modules/31-portal/outbox-consumers/m17-visit-cancelled-telehealth.ts — the §4.10
// `m17.visit.cancelled` (telehealth-scoped) binding (F-139/#248's follow-up build).
//
// M31's own §4.10 "M31 consumes" table names this pair with a real, previously-unbuilt consumer file
// (`m17-visit-cancelled-telehealth.ts`) whose effect is "Force-end vendor room". `telehealth_visit` is one
// of M31's three owned tables (unique on `m17_visit_id`, §3.3) — a cancelled M17 visit that never ran as
// telehealth simply has no matching row, which is the ordinary, idempotent no-op case (no telehealth flag
// was ever set on that visit).
//
// THE VENDOR HALF IS DELIBERATELY NOT ATTEMPTED, AND THAT IS A REPORTED GAP, NOT A SHORTCUT TAKEN HERE.
// `TelehealthProvider.endRoom(vendorRoomId)` (`@wardenx/telehealth-client`) needs the DECRYPTED vendor room
// id, but `telehealth_visit.vendor_room_id_cipher` has NO DECRYPT PATH ANYWHERE IN THIS CODEBASE —
// `portal-crypto.ts`'s own header says so explicitly for its one cipher ("there is deliberately no decrypt
// here... nothing reads the reason back yet"), and that file doesn't even cover this column (only
// `status_change_reason_cipher`). Confirmed by reading the ONE production call site that already has this
// exact need: `routes/telehealth.routes.ts`'s staff-side `/end` route forces the DB-side lifecycle
// transition but never calls `adapter.endRoom` either — the identical gap already sitting, unaddressed, in
// the one route that should be evidence this consumer could copy. Rather than inventing a new decrypt
// capability inside an outbox-consumer file (real crypto/schema work, out of this build's isolated-file
// scope), this consumer does the AUTHORITATIVE half: it marks the room `ended_aborted` in M31's own record.
// That is what actually protects a caregiver from joining a cancelled visit's room — `foldParticipantJoin`
// (telehealth/visit-lifecycle.ts) refuses a join once the visit is in any ended state, so the join route
// itself is the real enforcement point, not the (currently unreachable) vendor force-close call.
//
// No `m31.telehealth.visit_ended` is emitted here: that event's own §4.10 catalog trigger is "vendor
// `room_ended` webhook", and — independently confirmed while building this — NOTHING in this codebase
// currently emits ANY `m31.*` outbox event in production (the vendor-webhook route verifies the HMAC
// signature and returns `{received:true}` with no store write and no publish at all). Inventing the first
// `m31.*` emission from a consumer whose job is to CONSUME, for an event this path was never documented to
// trigger, would be exactly the "declared a relationship that was never decided" shape this whole build arc
// exists to correct in the other direction.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { TelehealthLifecycleState } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import { canTransitionTelehealth } from "../telehealth/visit-lifecycle";

const TV = schema.telehealthVisits;

/** Not a real membership row — mirrors M18's own established system-actor sentinel convention
 *  (`M18_SYSTEM_USER_ID`) for a table with no actor/membership column this consumer needs to stamp. */
const CONSUMER_USER_ID = "";

export const M31_VISIT_CANCELLED_TELEHEALTH_CONSUMER = {
  eventName: "m17.visit.cancelled",
  consumerName: "m31.m17-visit-cancelled-telehealth",
} as const;

export interface VisitCancelledTelehealthConsumerDeps {
  readonly db: DbClient;
}

function factsOf(payload: unknown): { visitId: string; reason: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const visitId = p.visitId;
  if (typeof visitId !== "string" || visitId.length === 0) {
    throw new Error(
      `${M31_VISIT_CANCELLED_TELEHEALTH_CONSUMER.consumerName}: payload has no visitId`,
    );
  }
  const reason = typeof p.reason === "string" ? p.reason : "";
  return { visitId, reason };
}

/**
 * M31's live `m17.visit.cancelled` binding. Idempotent by construction: `telehealth_visit_m17_visit_unique`
 * means at most one row can ever match, and the WHERE clause below only ever matches a row that is still
 * pre-ended, so a redelivery (or a visit with no telehealth room at all) finds nothing left to do.
 */
export function buildM31VisitCancelledTelehealthConsumer(
  deps: VisitCancelledTelehealthConsumerDeps,
) {
  return {
    consumerName: M31_VISIT_CANCELLED_TELEHEALTH_CONSUMER.consumerName,
    consumerModule: "m31" as const,
    eventTypes: [M31_VISIT_CANCELLED_TELEHEALTH_CONSUMER.eventName] as const,
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

          const [row] = await tx
            .select({
              id: TV.id,
              lifecycleState: TV.lifecycleState,
              visitStartedAt: TV.visitStartedAt,
              version: TV.version,
            })
            .from(TV)
            .where(and(eq(TV.organizationId, organizationId), eq(TV.m17VisitId, facts.visitId)))
            .limit(1);
          if (!row) return; // this M17 visit never had a telehealth room minted — nothing to end.

          const current = row.lifecycleState as TelehealthLifecycleState;
          if (!canTransitionTelehealth(current, "ended_aborted")) return; // already ended/reconciled.

          const startedMs = row.visitStartedAt ? row.visitStartedAt.getTime() : null;
          const now = new Date();

          await tx
            .update(TV)
            .set({
              lifecycleState: "ended_aborted",
              visitEndedAt: now,
              endReason: "other", // no `cancelled`/`rescheduled` member exists on TelehealthEndReason (§3.3)
              totalDurationSec: startedMs
                ? Math.max(0, Math.round((now.getTime() - startedMs) / 1000))
                : null,
              version: row.version + 1,
              updatedAt: now,
            })
            .where(and(eq(TV.id, row.id), eq(TV.version, row.version)));
          // No `.returning()` check needed beyond the WHERE-on-version race guard: a lost race here means
          // another writer already moved the row past this transition in the same tick, which is the
          // correct outcome to leave alone (the M18 consumer precedent's "lost a version race — the next
          // tick sees it" reasoning, except there is no next tick for a one-shot cancellation — the row is
          // already where this consumer wanted it).
        },
      );
    },
  };
}
