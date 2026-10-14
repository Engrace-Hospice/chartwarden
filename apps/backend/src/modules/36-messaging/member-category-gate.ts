// ADR-0058 design review F6 - the membership-write chokepoint's role-category refusal.
//
// An identity holding an active-or-disabled role of category `patient_family`, `external_auditor` or `platform_staff` never
// becomes a channel member: those categories are deliberately outside the workforce messaging surface (the global search role
// gate denies them, the member picker never offers them). Without this, an admin could `addMember` such an identity into a
// non-family channel and the identity could read history through the channel-member path.
//
// Sanctioned flows (investigated): patient families message through PORTAL ACCOUNTS (`author_kind` portal, M31 seam), which are
// not `channel_member` rows at all; external auditors read through the engagement-scoped M2 routes; platform staff have no
// tenant messaging surface. So no kind legitimately holds these categories as a member: the refusal is unconditional.
//
// Every code path that writes a `channel_member` row (insert OR re-activation) must call this module; the unit ratchet
// `member-category-gate.test.ts` fails when a new write path skips it.
import { schema } from "@wardenx/db";
import { WardenXError } from "@wardenx/types";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { GLOBAL_SEARCH_ROLE_POLICY } from "./global-search/role-gate";
import type { Tx } from "./messaging-write-core";


export const MEMBER_CATEGORY_NOT_ALLOWED = "MEMBER_CATEGORY_NOT_ALLOWED";

/** The same deny set the global search role gate uses (one source of truth for "not a workforce messaging identity"). */
const EXCLUDED_CATEGORIES = Object.entries(GLOBAL_SEARCH_ROLE_POLICY)
  .filter(([, policy]) => policy === "deny")
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
        inArray(schema.roles.category, EXCLUDED_CATEGORIES as never),
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
  throw new WardenXError(
    MEMBER_CATEGORY_NOT_ALLOWED,
    "this identity's role category cannot be a channel member",
    422,
  );
}
