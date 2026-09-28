// apps/backend/src/modules/17-scheduling/outbox-consumers/m18-evv-at-patient-address.ts — the D14
// EVV-authoritative `en_route → in_visit` advance (F-152, #248).
//
// The mirror of `m18-evv-check-in.ts` one state further along the D3 chain: `transitionVisit`'s
// `VisitAdvanceSource: { via: "evv" }` doc comment names `m18.evv.at_patient_address` explicitly as the
// second of the two events that can "match this visit (system actor)" — check-in starts the visit
// (`published → en_route`), and the geofence-confirmed arrival at the patient's address is what actually
// puts the clinician `in_visit`. Nothing ever bound it — the pair sat in
// `scripts/outbox-deferred-consumers.ts`'s m17 `handlers-unbound` group. Mirrors
// `SchedulingRouteService.arriveVisit`'s self-attest write path exactly (status, evvBracketState, the
// `visit_state_history` append), with the F-102 `CONSUMER_USER_ID` convention in place of a staff
// membership. Unlike `arriveVisit`, this consumer does not emit an outbox event on `arrive` — neither
// does the route-layer method, since no `m17.visit.arrived`/`.in_visit` catalog entry exists; `arrive`
// is otherwise silent until `m8.encounter.signed` completes the visit.
import { type DbClient, schema } from "@wardenx/db";
import { transitionVisit } from "@wardenx/scheduling";
import { withOrgContext } from "@wardenx/tenancy";
import type { VisitStatus } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

const V = schema.visit;
const VSH = schema.visitStateHistory;

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M17_EVV_AT_PATIENT_ADDRESS_CONSUMER = {
  eventName: "m18.evv.at_patient_address",
  consumerName: "m17.m18-evv-at-patient-address",
} as const;

export interface EvvAtPatientAddressDeps {
  readonly db: DbClient;
}

function factsOf(payload: unknown): { visitId: string; confirmedAt: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const read = (key: string): string => {
    const value = p[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${M17_EVV_AT_PATIENT_ADDRESS_CONSUMER.consumerName}: payload has no ${key}`);
    }
    return value;
  };
  return { visitId: read("visitId"), confirmedAt: read("confirmedAt") };
}

/**
 * M17's live `m18.evv.at_patient_address` binding — the D14 EVV-authoritative `en_route → in_visit`
 * advance. Idempotent the same way `buildM17EvvCheckInConsumer` is: the UPDATE's WHERE clause pins
 * `status = 'en_route'`, so a redelivery after the visit has already advanced matches zero rows.
 */
export function buildM17EvvAtPatientAddressConsumer(deps: EvvAtPatientAddressDeps) {
  return {
    consumerName: M17_EVV_AT_PATIENT_ADDRESS_CONSUMER.consumerName,
    consumerModule: "m17" as const,
    eventTypes: [M17_EVV_AT_PATIENT_ADDRESS_CONSUMER.eventName] as const,
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
          if (!visit) return;
          if (visit.status !== "en_route") return; // not eligible for `arrive`; idempotent no-op

          transitionVisit(visit.status as VisitStatus, {
            type: "arrive",
            source: { via: "evv" },
          });

          const [updated] = await tx
            .update(V)
            .set({
              status: "in_visit",
              evvBracketState: "evv_present",
              version: visit.version + 1,
              updatedAt: new Date(),
            })
            .where(and(eq(V.id, facts.visitId), eq(V.status, "en_route")))
            .returning({ id: V.id });
          if (!updated) return;

          await tx.insert(VSH).values({
            organizationId,
            providerEntityId: visit.providerEntityId,
            locationId: visit.locationId,
            visitId: facts.visitId,
            fromState: "en_route",
            toState: "in_visit",
            actorMembershipId: null,
            systemSource: "evv_at_patient_address",
            reason: null,
            outboxEventId: event.id,
          });
        },
      );
    },
  };
}
