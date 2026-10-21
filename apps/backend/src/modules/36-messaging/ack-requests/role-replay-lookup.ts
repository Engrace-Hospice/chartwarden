// apps/backend/src/modules/36-messaging/ack-requests/role-replay-lookup.ts - ADR-0081: the read a role send needs to replay a retry. It lives in the
// aggregate's directory because it selects the request table; the urgent code stays unaware of the aggregate (m36-ack-static). Select only.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";

const MSG = schema.messages;

/**
 * ADR-0081: what a role send needs to know about the message this author already stored under this client id in this channel: the
 * recipient and the ROLE its response request was addressed to (null for a person-send, or when no request was tracked). Null when none.
 */
export function createDbRoleReplayLookup(
  db: DbClient,
): (
  orgId: string,
  authorUserId: string,
  channelId: string,
  clientMessageId: string,
) => Promise<{ readonly recipient: string | null; readonly role: string | null } | null> {
  const REQ = schema.messageAckRequests;
  return (orgId, authorUserId, channelId, clientMessageId) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const [row] = await tx
        .select({ recipient: MSG.urgentRecipientUserId, role: REQ.addressedRole })
        .from(MSG)
        .leftJoin(REQ, and(eq(REQ.organizationId, MSG.organizationId), eq(REQ.messageId, MSG.id)))
        .where(
          and(
            eq(MSG.organizationId, orgId),
            eq(MSG.authorUserId, authorUserId),
            eq(MSG.channelId, channelId),
            eq(MSG.clientMessageId, clientMessageId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
}
