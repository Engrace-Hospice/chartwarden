// ADR-0058 design review F6 - the membership-write chokepoint's role-category refusal.
//
// An identity holding an active-or-disabled role of category `patient_family`, `external_auditor` or `platform_staff` never
// becomes a channel member: those categories are deliberately outside the workforce messaging surface (the global search role
// gate denies them, the member picker never offers them). Without this, an admin could `addMember` such an identity into a
// non-family channel and the identity could read history through the channel-member path.
//
// Sanctioned flows (investigated): external auditors read through the engagement-scoped M2 routes; platform staff have no
// tenant messaging surface. Patient families DO have `channel_member` rows for portal_caregiver users (messaging-write-core.ts,
// alert-emitter-drizzle.ts, the portal send path), but no code grants those portal users an excluded role category, so the
// gate does not block them today. A future grant of an excluded role to such a user WOULD block openChannel creator rows
// and roster sync for them: revisit this gate before adding one. The refusal is otherwise unconditional.
//
// Every code path that writes a `channel_member` row (insert OR re-activation) must call this module; the unit ratchet
// `member-category-gate.test.ts` fails when a new write path skips it.
import { schema } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import { and, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { GLOBAL_SEARCH_ROLE_POLICY } from "./global-search/role-gate";
import type { Tx } from "./messaging-write-core";

export const MEMBER_CATEGORY_NOT_ALLOWED = "MEMBER_CATEGORY_NOT_ALLOWED";

/** Categories the global search role gate does not deny ("allow"/"off"); anything else is excluded.
 * Unknown categories fail closed, like role-gate.ts `policyOf` (not in the policy map => not listed here => excluded). */
const ALLOWED_CATEGORIES = Object.entries(GLOBAL_SEARCH_ROLE_POLICY)
  .filter(([, policy]) => policy !== "deny")
  .map(([category]) => category);

/**
 * The subset of `userIds` holding an excluded role category in this org. A disabled role still counts (deny wins), and an
 * expired grant does not.
 */
export async function excludedMemberUserIds(
  tx: Tx,
  orgId: string,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .innerJoin(
      schema.membershipRoles,
      and(
        eq(schema.membershipRoles.membershipId, schema.memberships.id),
        eq(schema.membershipRoles.organizationId, schema.memberships.organizationId),
      ),
    )
    .innerJoin(schema.roles, eq(schema.roles.id, schema.membershipRoles.roleId))
    .where(
      and(
        eq(schema.memberships.organizationId, orgId),
        inArray(schema.memberships.userId, [...userIds]),
        notInArray(schema.roles.category, ALLOWED_CATEGORIES as never),
        or(
          isNull(schema.membershipRoles.expiresAt),
          sql`${schema.membershipRoles.expiresAt} > now()`,
        ),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

/** Refuse (422 MEMBER_CATEGORY_NOT_ALLOWED) when the identity holds an excluded category. */
export async function assertMemberCategoryAllowed(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<void> {
  if ((await excludedMemberUserIds(tx, orgId, [userId])).size === 0) return;
  throw new ChartWardenError(
    MEMBER_CATEGORY_NOT_ALLOWED,
    "this identity's role category cannot be a channel member",
    422,
  );
}

/**
 * ADR-0058 F6 go-live check: does any live `channel_member` row belong to an identity holding an excluded role category?
 * The meaning of runbook Stage 6b exactly: a membership not revoked, an unremoved channel member, an unexpired grant, and a
 * disabled role still counts (deny wins). The category set is the one the write gate uses (anything the search role gate
 * does not allow or switch off is excluded).
 */
export async function excludedChannelMembersExist(tx: Tx, orgId: string): Promise<boolean> {
  const rows = await tx
    .select({ channelId: schema.channelMembers.channelId })
    .from(schema.channelMembers)
    .innerJoin(
      schema.memberships,
      and(
        eq(schema.memberships.userId, schema.channelMembers.userId),
        eq(schema.memberships.organizationId, schema.channelMembers.organizationId),
      ),
    )
    .innerJoin(
      schema.membershipRoles,
      and(
        eq(schema.membershipRoles.membershipId, schema.memberships.id),
        eq(schema.membershipRoles.organizationId, schema.memberships.organizationId),
      ),
    )
    .innerJoin(schema.roles, eq(schema.roles.id, schema.membershipRoles.roleId))
    .where(
      and(
        eq(schema.channelMembers.organizationId, orgId),
        ne(schema.memberships.status, "revoked"),
        isNull(schema.channelMembers.removedAt),
        notInArray(schema.roles.category, ALLOWED_CATEGORIES as never),
        or(
          isNull(schema.membershipRoles.expiresAt),
          sql`${schema.membershipRoles.expiresAt} > now()`,
        ),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
