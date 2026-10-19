// apps/backend/src/modules/36-messaging/notification-policy-ports.ts - WP 4.6 (ADR-0073): the two DB-facing ports the notification
// policy needs on top of the AlertEmitter ports. Kept out of alert-emitter-drizzle.ts so that file stays about recipients and persistence.
//   - policyEnabledFor: the ops flag `messaging.notification_policy` AND the flag of the event's own family are both on for the tenant.
//   - verifiedChannelsFor: per user, the channels with a VERIFIED endpoint, through migration 1123's SECURITY DEFINER reader (tenant-scoped
//     by active membership; returns channel names only, never an endpoint value).
// Both let an error propagate: the emit fails and the outbox retries. A flag or endpoint read we could not make must never silently turn a
// safety route into "no route".
import type { DbClient } from "@wardenx/db";
import type { NotificationChannel } from "@wardenx/messaging";
import {
  ACK_REQUESTS_FLAG_KEY,
  NOTIFICATION_POLICY_FLAG_KEY,
  URGENT_CLINICAL_FLAG_KEY,
} from "@wardenx/types";
import { sql } from "drizzle-orm";

export interface PolicyFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

const URGENT_SENT = "m36.message.urgent_sent";

/** The flag that gates the event's own family: urgent_sent -> urgent_clinical, any other designated event (m36.ack.*) -> ack_requests. */
function familyFlagFor(eventType: string): string {
  return eventType === URGENT_SENT ? URGENT_CLINICAL_FLAG_KEY : ACK_REQUESTS_FLAG_KEY;
}

/** Pure: both the policy flag and the event's family flag are on. Absent = off. */
export function policyFlagsAllow(flags: Record<string, boolean>, eventType: string): boolean {
  return flags[NOTIFICATION_POLICY_FLAG_KEY] === true && flags[familyFlagFor(eventType)] === true;
}

export function createPolicyEnabledPort(
  flags: PolicyFlagReader | undefined,
): (orgId: string, eventType: string) => Promise<boolean> {
  return async (orgId, eventType) =>
    flags ? policyFlagsAllow(await flags.forOrg(orgId), eventType) : false;
}

const ENDPOINT_CHANNELS: ReadonlySet<string> = new Set(["push", "sms", "email"]);

export function createVerifiedChannelsPort(
  db: DbClient,
): (
  orgId: string,
  userIds: readonly string[],
) => Promise<ReadonlyMap<string, ReadonlySet<NotificationChannel>>> {
  return async (orgId, userIds) => {
    const byUser = new Map<string, Set<NotificationChannel>>();
    if (userIds.length === 0) return byUser;
    const result = await db.execute<{ user_id: string; channel: string }>(sql`
      SELECT * FROM delivery_endpoint_verified_channels_for_org_users(
        ${orgId},
        ${JSON.stringify(userIds)}::jsonb
      )
    `);
    for (const row of result.rows) {
      if (!ENDPOINT_CHANNELS.has(row.channel)) continue;
      const set = byUser.get(row.user_id) ?? new Set<NotificationChannel>();
      set.add(row.channel as NotificationChannel);
      byUser.set(row.user_id, set);
    }
    return byUser;
  };
}
