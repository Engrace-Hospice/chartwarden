// apps/backend/src/modules/17-scheduling/outbox-consumers/m18-evv-check-out.ts — the §3.3 provenance
// pointer M17's own schema comment already promises (F-133/F-152 follow-up, #248).
//
// `visit.evv_check_out_event_id` has existed since M17-T02 — "M17 does not enforce them existing; M18
// owns the rows; M17 STORES THE POINTER SET on receipt of the M18 outbox event" (module spec §3.3, the
// same sentence that describes `evv_check_in_event_id`, which `buildM17EvvCheckInConsumer` already wires).
// Nothing had ever written the checkout half — the pair sat in `scripts/outbox-deferred-consumers.ts`'s
// m17 `handlers-unbound` group.
//
// DELIBERATELY NARROWER than M18's own catalog DESCRIPTION for this event
// (`apps/backend/src/modules/18-evv/events-by-m18.ts`, "...drives M17's `in_visit → completed`
// transition (D14)"). That description is stale against the RECONCILED machine: M17's own spec body is
// explicit that completion is driven by `m8.encounter.signed` ALONE —
//   • §2.2 state diagram: "in_visit --> completed: m8.encounter.signed received AND M17 in_visit"
//   • §2.5 side-effects table: "`in_visit → completed`: requires `m8.encounter.signed` outbox event...
//     If a visit goes `in_visit` and no encounter signs within 48 hours, the stale-visit-sweep cron
//     flags it; no automatic transition."
//   • §7.1 "Done means": "RN drives to home, M18 publishes `evv.check_in_recorded`... on
//     `m8.encounter.signed` arrival, M17 transitions `in_visit → completed`."
// and `packages/scheduling/src/lifecycle/visit-machine.ts`'s `complete` case requires
// `event.isSystemActor` with a doc comment naming exactly one caller: "fired by the `m8.encounter.signed`
// consumer referencing this `visit_id` (system actor)" — already the live binding in
// `consumers/index.ts`. Firing `complete` from THIS event as well would create a second, undocumented
// completion path with no corresponding spec guard (nothing says which of the two "wins" a race, and
// M17-F03 struck the only vocabulary — `evv_missing_attested`/`completed_via_evv` — that used to give a
// checkout-driven intermediate state room to exist). That is a product decision this pass does not make
// unilaterally; reported to the coordinator rather than guessed at.
//
// So this consumer does exactly what M17's own spec commits to and nothing else: stamp the pointer.
// Deliberately no `visit_state_history` row (no lifecycle state changes) and no outbox emission (nothing
// downstream reads this pointer today — confirmed by a repo-wide grep — so inventing a notification would
// be advertising a fact no consumer asked for).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";

const V = schema.visit;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M17_EVV_CHECK_OUT_CONSUMER = {
  eventName: "m18.evv.check_out_recorded",
  consumerName: "m17.m18-evv-check-out",
} as const;

export interface EvvCheckOutDeps {
  readonly db: DbClient;
}

function factsOf(payload: unknown): { eventId: string; visitId: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M17_EVV_CHECK_OUT_CONSUMER.consumerName}: payload has no ${key}`);
    }
    return value;
  };
  return { eventId: read("eventId"), visitId: read("visitId") };
}

/**
 * M17's live `m18.evv.check_out_recorded` binding — records the M18 checkout event's id on the visit row
 * (§3.3 provenance pointer only, no lifecycle transition — see the file header). Idempotent by
 * construction: the UPDATE's WHERE clause requires `evv_check_out_event_id IS NULL`, so a redelivery
 * after the pointer is already set matches zero rows and is a silent no-op — it never overwrites an
 * already-recorded pointer with a different value.
 */
export function buildM17EvvCheckOutConsumer(deps: EvvCheckOutDeps) {
  return {
    consumerName: M17_EVV_CHECK_OUT_CONSUMER.consumerName,
    consumerModule: "m17" as const,
    eventTypes: [M17_EVV_CHECK_OUT_CONSUMER.eventName] as const,
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

          await tx
            .update(V)
            .set({
              evvCheckOutEventId: facts.eventId,
              updatedAt: new Date(),
            })
            .where(and(eq(V.id, facts.visitId), isNull(V.evvCheckOutEventId)));
          // No `.returning()` check needed — a zero-row match (cross-tenant / already-set / visit not
          // found) is a correct no-op in every case, not an error to detect.
        },
      );
    },
  };
}
