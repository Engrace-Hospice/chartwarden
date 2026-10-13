// apps/backend/src/modules/36-messaging/mention-non-member-service-db.ts - WP 2.3: who can be offered "Add <name>?".
//
// ACCESS: the caller must already see the channel (`canViewChannel`, the same predicate the route ran); anything else is
// the one 404 a random channel id gets. This lists NAMES ONLY (no email, role, MRN or thread text), needs a 2+ character
// query, is capped, and never grants access: a mention reference is still only accepted for a current member (see
// `sendMessage`), and joining the channel is the separate, permission-gated `addMember`.
import { type DbClient, schema } from "@wardenx/db";
import type { MentionNonMember, MessagingRouteService } from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

const CH = schema.channels;
const CM = schema.channelMembers;
const MEMBERSHIP = schema.memberships;
const MEMBERSHIP_ROLE = schema.membershipRoles;
const ROLE = schema.roles;
const USER = schema.users;

export const MENTION_NON_MEMBER_MIN_QUERY = 2;
export const MENTION_NON_MEMBER_LIMIT = 10;
const MAX_QUERY_LENGTH = 100;

export function createDbMentionNonMemberSearch(deps: {
  readonly db: DbClient;
  readonly canViewChannel: MessagingRouteService["canViewChannel"];
}): Pick<MessagingRouteService, "searchMentionNonMembers"> {
  const { db, canViewChannel } = deps;
  return {
    async searchMentionNonMembers(orgId, userId, channelId, query): Promise<MentionNonMember[]> {
      if (!(await canViewChannel(orgId, userId, channelId))) {
        throw new NotFoundError("channel", channelId);
      }
      // The length is judged on what the user typed; escaping must not turn one character into two.
      const typed = query.trim().slice(0, MAX_QUERY_LENGTH);
      if (typed.length < MENTION_NON_MEMBER_MIN_QUERY) return [];
      // Escape LIKE metacharacters so the query is a literal substring.
      const needle = typed.replace(/[\\%_]/g, "\\$&");
      return withOrgContext(db, { organizationId: orgId, userId }, async (tx) => {
        const [channel] = await tx
          .select({ kind: CH.channelKind })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
          .limit(1);
        // A direct message's members are fixed and the announcement channel has no member rows (it is tenant-wide).
        if (!channel || channel.kind === "dm" || channel.kind === "announcement") return [];
        const rows = await tx
          .select({ entityId: USER.id, displayName: USER.name })
          .from(MEMBERSHIP)
          .innerJoin(USER, eq(USER.id, MEMBERSHIP.userId))
          .where(
            and(
              eq(MEMBERSHIP.organizationId, orgId),
              eq(MEMBERSHIP.status, "active"),
              eq(USER.status, "active"),
              sql`${USER.id} <> ${userId}::uuid`,
              sql`${USER.name} ILIKE ${`%${needle}%`}`,
              // Staff only: an external auditor or a patient/family identity is never offered, nor can be added from here.
              sql`NOT EXISTS (
                SELECT 1 FROM ${MEMBERSHIP_ROLE}
                INNER JOIN ${ROLE} ON ${ROLE.id} = ${MEMBERSHIP_ROLE.roleId}
                WHERE ${MEMBERSHIP_ROLE.organizationId} = ${orgId}::uuid
                  AND ${MEMBERSHIP_ROLE.membershipId} = ${MEMBERSHIP.id}
                  AND ${ROLE.category} IN ('external_auditor', 'patient_family', 'platform_staff')
                  AND (${MEMBERSHIP_ROLE.expiresAt} IS NULL OR ${MEMBERSHIP_ROLE.expiresAt} > now())
              )`,
              sql`NOT EXISTS (
                SELECT 1 FROM ${CM}
                WHERE ${CM.organizationId} = ${orgId}::uuid
                  AND ${CM.channelId} = ${channelId}::uuid
                  AND ${CM.userId} = ${USER.id}
                  AND ${isNull(CM.removedAt)}
              )`,
            ),
          )
          .orderBy(asc(USER.name), asc(USER.id))
          .limit(MENTION_NON_MEMBER_LIMIT);
        return rows.flatMap((row) => {
          const displayName = row.displayName?.trim() ?? "";
          return displayName ? [{ entityId: row.entityId, displayName }] : [];
        });
      });
    },
  };
}

/**
 * WP 2.3: the sender's display name for the mention notification text. A relay tick is not a request, so this takes the
 * organization explicitly and only answers for a current member of THAT organization (a foreign id yields null).
 */
export function createMentionActorNameResolver(
  db: DbClient,
): (orgId: string, userId: string) => Promise<string | null> {
  return (orgId, userId) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const [row] = await tx
        .select({ name: USER.name })
        .from(MEMBERSHIP)
        .innerJoin(USER, eq(USER.id, MEMBERSHIP.userId))
        .where(and(eq(MEMBERSHIP.organizationId, orgId), eq(MEMBERSHIP.userId, userId)))
        .limit(1);
      return row?.name?.trim() || null;
    });
}
