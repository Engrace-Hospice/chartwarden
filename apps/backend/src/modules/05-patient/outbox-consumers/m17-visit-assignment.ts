// apps/backend/src/modules/05-patient/outbox-consumers/m17-visit-assignment.ts — the LIVE
// `m17.visit.assigned`/`.unassigned` consumers that feed M5's shift-assignment caseload cache (F-165,
// #248, closing 2 of the 8 pairs the m5 `handlers-unbound` group named — see
// `scripts/outbox-deferred-consumers.ts` for the F-138 finding this build resolves and the six
// `m39.consent.*` events it deliberately leaves untouched).
//
// Both events already declare `m5` in their catalogued `declaredConsumers`
// (`17-scheduling/events-by-m17.ts`) — no catalog edit was needed to bind these.
//
// The membershipId→userId resolution happens HERE, at write time, via `membershipUserIdForOrg`
// (`../seams/drizzle-stores.ts`) — the Valkey cache itself is keyed by the clinician's raw Better Auth
// user id (`CaseloadStore`'s own id space), never a membership id, so the hot ABAC read path
// (`isAssigned`/`assignedPatientIds`) never needs a DB round trip. See
// `../seams/shift-caseload-cache.ts` for the key scheme, the read-time-filtered expiry, and the
// deliberate fail-open-on-Redis-error posture.
import type Redis from "ioredis";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { removeShiftAssignment, writeShiftAssignment } from "../seams/shift-caseload-cache";

export interface VisitAssignmentDeps {
  readonly redis: Redis;
  /** M5's org-explicit `membershipUserIdForOrg` seam read, injected as a port (matches the
   *  `orderPatientAndKind` / `hopeAssessmentPatientIdForOrg` shape this arc already established). */
  readonly membershipUserId: (
    organizationId: string,
    membershipId: string,
  ) => Promise<string | null>;
}

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `m17.visit.assigned` → write one shift-cache entry (visitId → {patientId, expiresAt}) into the
 * clinician's Valkey hash, TTLed off the visit's own `scheduledEndedAt` plus a fixed grace window.
 */
export function buildM5VisitAssignedConsumer(deps: VisitAssignmentDeps): OutboxConsumerBinding {
  return {
    consumerName: "m5.m17-visit-assigned",
    consumerModule: "m5",
    eventTypes: ["m17.visit.assigned"],
    async handle(event): Promise<void> {
      const visitId = stringField(event.payload, "visitId");
      const membershipId = stringField(event.payload, "assignedMembershipId");
      const patientId = stringField(event.payload, "patientId");
      const scheduledEndedAt = stringField(event.payload, "scheduledEndedAt");
      if (visitId === null || membershipId === null || patientId === null || scheduledEndedAt === null) {
        throw new Error("m5.m17-visit-assigned: payload missing a required field");
      }
      const userId = await deps.membershipUserId(event.organizationId, membershipId);
      // No membership row visible in this org (stale/cross-tenant/deleted id) — nothing to cache. Not
      // an error: a later event for a real membership still resolves correctly (the
      // `orderPatientAndKindForOrg` "no matching order_record" precedent).
      if (userId === null) return;
      await writeShiftAssignment(deps.redis, event.organizationId, userId, visitId, patientId, scheduledEndedAt);
    },
  };
}

/**
 * `m17.visit.unassigned` → remove the visit's shift-cache entry. A visit id already expired or never
 * written is a true no-op (HDEL is idempotent) — no error on a redelivery or a visit that was never
 * shift-cached in the first place (e.g. assigned before this consumer was bound).
 */
export function buildM5VisitUnassignedConsumer(deps: VisitAssignmentDeps): OutboxConsumerBinding {
  return {
    consumerName: "m5.m17-visit-unassigned",
    consumerModule: "m5",
    eventTypes: ["m17.visit.unassigned"],
    async handle(event): Promise<void> {
      const visitId = stringField(event.payload, "visitId");
      const membershipId = stringField(event.payload, "formerAssignedMembershipId");
      if (visitId === null || membershipId === null) {
        throw new Error("m5.m17-visit-unassigned: payload missing a required field");
      }
      const userId = await deps.membershipUserId(event.organizationId, membershipId);
      if (userId === null) return;
      await removeShiftAssignment(deps.redis, event.organizationId, userId, visitId);
    },
  };
}

