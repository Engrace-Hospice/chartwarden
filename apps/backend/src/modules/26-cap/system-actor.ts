// apps/backend/src/modules/26-cap/system-actor.ts — M26's system actor for cron writes.
//
// `M26_WORKER_SYSTEM_USER_ID` is a sentinel, not a real `user` row: the §4.8 crons stamp it on the cap
// rows they author (`cap_period.closed_by` on a year close — a logical uuid column with no FK). It must
// never reach `app.user_id`: the M4 write-audit trigger copies that GUC into `audit_event.actor_user_id`,
// a real FK to `user(id)`, so every audited write a cron made under it (the nightly projection's
// `cap_projection_snapshot` insert, the year-close `cap_period` update) failed with 23503
// `audit_event_actor_user_id_user_id_fk`. The sentinel maps to the NULL (system) audit actor instead —
// the M17 `orgContextFor` precedent.
import { type OrgContext, systemOrgContext } from "@chartwarden/tenancy";

export const M26_WORKER_SYSTEM_USER_ID = "00000000-0000-0000-0000-0000000000e6";

/** The `withOrgContext` scope for an M26 actor: a real user as-is; the cron sentinel as the NULL actor. */
export function orgContextFor(actor: {
  readonly organizationId: string;
  readonly userId: string;
}): OrgContext {
  return actor.userId === M26_WORKER_SYSTEM_USER_ID
    ? systemOrgContext(actor.organizationId)
    : { organizationId: actor.organizationId, userId: actor.userId };
}
