// apps/backend/src/modules/17-scheduling/system-actor.ts — M17's system actor for relay/cron writes.
//
// `M17_SYSTEM_USER_ID` is a sentinel, not a real `user` row: it marks a visit cancelled/created by the
// scheduler itself (`cancelled_by_membership_id`, `m17.visit.cancelled.cancelledBy`, history actor). It
// must never reach `app.user_id`: the M4 write-audit trigger copies that GUC into
// `audit_event.actor_user_id`, a real FK to `user(id)`, so every audited write a relay tick made under the
// sentinel failed with 23503 `audit_event_actor_user_id_user_id_fk`. The repository's convention for a
// consumer/worker write is the empty actor (`""`, which the trigger records as a NULL actor — see
// `m20-safety-visit-cancellation.ts`, `05-patient/deceased-db.ts`).

import type { OrgContext } from "@wardenx/tenancy";

export const M17_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000017";

/**
 * The `withOrgContext` scope for a write made as `userId`: a real user id as-is; the system sentinel as
 * the NULL actor with `systemActor: true`, so it does not inherit an ambient request actor either (the
 * care-plan proposal path runs inside `runWithRequestContext` — GAP-111).
 */
export function orgContextFor(organizationId: string, userId: string): OrgContext {
  return userId === M17_SYSTEM_USER_ID
    ? { organizationId, userId: "", systemActor: true }
    : { organizationId, userId };
}
