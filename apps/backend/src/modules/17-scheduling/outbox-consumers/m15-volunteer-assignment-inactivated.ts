// apps/backend/src/modules/17-scheduling/outbox-consumers/m15-volunteer-assignment-inactivated.ts — the
// §7.5 volunteer-gate-expiry scheduler warning (F-166, #248).
//
// M15's own catalog entry for `m15.volunteer.assignment_inactivated` says outright: "Open volunteer
// assignments were inactivated by a gate expiry, so M17 must drop the volunteer from the schedule (§7.5)."
// F-133 named this "a whole unbuilt reassignment-scan subsystem" — re-checked directly against the current
// schema before this build, not re-asserted, and the literal reading ("drop the volunteer") is genuinely
// NOT buildable: `visit.assigned_membership_id` is NOT NULL (`06-admission`-sibling `visits.ts`, checked
// directly) — there is no "unassigned but still on the schedule" state for a visit row, only a
// full CANCEL (destroys the visit) or a REASSIGN to a specific new membership (`reassignVisit`, which
// needs a human to pick a replacement — the D8 pre-schedule gate requires a real candidate, and no
// automatic best-fit reassignment algorithm exists anywhere in this module to pick one honestly).
//
// What IS buildable, and is the platform's own designed answer for exactly this situation: M17 already
// carries a complete, catalogued, alert-wired `m17.reassignment_needed` event
// (`events-by-m17.ts`/`alerts-by-m17.ts`) whose payload's `reason` union has a dedicated
// `volunteer_gate_expired` member — WARN severity, `scheduling_scheduler_inbox` recipient,
// `requiresResponseTracking: true` — published by NOTHING in production (the sibling PTO-approval path
// that was meant to trigger it, `time-off-machine.ts`'s `trigger_reassignment_scan` effect, has no
// interpreter anywhere either — `approveTimeOff` hardcodes `affectedPublishedVisitCount: 0` and never
// reads the transition's own `.effects`). This consumer is the FIRST real producer of that alert: it
// scans for every non-terminal visit still assigned to the just-inactivated volunteer and emits the
// warning per visit, so a human scheduler sees the urgent need and picks a replacement through the
// existing `reassignVisit`/publish routes — the alert IS the "drop from the schedule" mechanism this
// module can honestly perform without guessing who replaces the volunteer.
//
// IDEMPOTENT BY CONSTRUCTION (retry-safety, not redelivery-after-success — the established convention
// every sibling consumer in this file relies on: the relay does not redeliver a event once its handler
// returns without throwing): the whole scan + emit batch runs inside ONE transaction, so a throw partway
// through commits nothing and a retry re-scans cleanly from scratch — never a partial double-alert.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray } from "drizzle-orm";

const V = schema.visit;

export interface M15VolunteerInactivatedOutboxPort {
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

export const M17_VOLUNTEER_ASSIGNMENT_INACTIVATED_CONSUMER = {
  eventName: "m15.volunteer.assignment_inactivated",
  consumerName: "m17.m15-volunteer-assignment-inactivated",
} as const;

export interface VolunteerAssignmentInactivatedConsumerDeps {
  readonly db: DbClient;
  readonly outbox: M15VolunteerInactivatedOutboxPort;
}

function factsOf(payload: unknown): { volunteerMembershipId: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const volunteerMembershipId = p.volunteerMembershipId;
  if (typeof volunteerMembershipId !== "string" || volunteerMembershipId.length === 0) {
    throw new Error(
      `${M17_VOLUNTEER_ASSIGNMENT_INACTIVATED_CONSUMER.consumerName}: payload has no volunteerMembershipId`,
    );
  }
  return { volunteerMembershipId };
}

/**
 * M17's live `m15.volunteer.assignment_inactivated` binding — warns the scheduler about every
 * non-terminal visit still assigned to a volunteer whose M15 gate just expired, via the existing
 * catalogued `m17.reassignment_needed` alert (`reason: "volunteer_gate_expired"`). Deliberately does NOT
 * attempt to clear or reassign `visit.assigned_membership_id` itself — see the file header.
 */
export function buildM17VolunteerAssignmentInactivatedConsumer(
  deps: VolunteerAssignmentInactivatedConsumerDeps,
) {
  return {
    consumerName: M17_VOLUNTEER_ASSIGNMENT_INACTIVATED_CONSUMER.consumerName,
    consumerModule: "m17" as const,
    eventTypes: [M17_VOLUNTEER_ASSIGNMENT_INACTIVATED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      const organizationId = event.organizationId;

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const affectedVisits = await tx
          .select({ id: V.id })
          .from(V)
          .where(
            and(
              eq(V.organizationId, organizationId),
              eq(V.assignedMembershipId, facts.volunteerMembershipId),
              inArray(V.status, ["published", "en_route", "in_visit"]),
            ),
          );

        for (const visit of affectedVisits) {
          await deps.outbox.publish(tx, {
            eventName: "m17.reassignment_needed",
            organizationId,
            aggregateKind: "visit",
            aggregateId: visit.id,
            payload: {
              visitId: visit.id,
              affectedMembershipId: facts.volunteerMembershipId,
              reason: "volunteer_gate_expired",
            },
          });
        }
      });
    },
  };
}
