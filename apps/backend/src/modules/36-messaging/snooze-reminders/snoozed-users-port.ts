// apps/backend/src/modules/36-messaging/snooze-reminders/snoozed-users-port.ts - WP 4.10 (ADR-0077): the alert emitter's snooze lookup.
// "Which of these users have an ACTIVE snooze of this conversation?" - through migration 1125's SECURITY DEFINER reader (session tenant
// only, user ids only), minus every user the snooze no longer covers: one who is the sender or assignee of an OPEN acknowledgment
// request in the conversation (a request opened after the snooze voids it for as long as it is open). Empty while the tenant flag is
// off. An error propagates: the emit fails and is retried.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { ACK_OPEN_STATUSES, SNOOZE_REMINDER_FLAG_KEY } from "@wardenx/types";
import { and, eq, inArray, or } from "drizzle-orm";
import { sql } from "drizzle-orm";

const ACK = schema.messageAckRequests;

export interface SnoozeFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

export function createSnoozedUsersPort(
  db: DbClient,
  flags: SnoozeFlagReader | undefined,
): (orgId: string, channelId: string, userIds: readonly string[]) => Promise<ReadonlySet<string>> {
  return async (orgId, channelId, userIds) => {
    if (userIds.length === 0 || !flags) return new Set();
    if ((await flags.forOrg(orgId))[SNOOZE_REMINDER_FLAG_KEY] !== true) return new Set();
    return withOrgContext(db, { organizationId: orgId, userId: "" }, async (tx) => {
      const snoozed = await tx.execute<{ user_id: string }>(sql`
        SELECT user_id FROM message_snoozed_users_for_channel(
          ${orgId}, ${channelId}, ${JSON.stringify(userIds)}::jsonb)
      `);
      const ids = snoozed.rows.map((r) => r.user_id);
      if (ids.length === 0) return new Set<string>();
      const voided = await tx
        .select({ assignee: ACK.assignedUserId, requester: ACK.requesterUserId })
        .from(ACK)
        .where(
          and(
            eq(ACK.organizationId, orgId),
            eq(ACK.channelId, channelId),
            inArray(ACK.status, [...ACK_OPEN_STATUSES]),
            or(inArray(ACK.assignedUserId, ids), inArray(ACK.requesterUserId, ids)),
          ),
        );
      const blocked = new Set(voided.flatMap((r) => [r.assignee, r.requester]));
      return new Set(ids.filter((id) => !blocked.has(id)));
    });
  };
}
