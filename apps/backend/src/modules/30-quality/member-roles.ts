// apps/backend/src/modules/30-quality/member-roles.ts — the ONE live-role lookup for a membership, shared by
// the §4.7 resolver (`loadMemberRoleKeys`) and the two-person close services (GAP-088).
//
// Returns `null` when the membership is not an ACTIVE membership of the org (unknown, other-org, pending,
// suspended or revoked) — such a person can never be a co-signer — otherwise the LIVE (unexpired, enabled,
// non-reserved-tenant-row) role keys.
import { roleConfersKey } from "@chartwarden/auth";
import { schema } from "@chartwarden/db";
import type { QualityDb } from "@chartwarden/quality";
import { and, eq, gt, isNull, or } from "drizzle-orm";

export async function selectActiveMemberRoleKeys(
  tx: QualityDb,
  organizationId: string,
  membershipId: string,
): Promise<readonly string[] | null> {
  const [member] = await tx
    .select({ status: schema.memberships.status })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.organizationId, organizationId),
        eq(schema.memberships.id, membershipId),
      ),
    )
    .limit(1);
  if (!member || member.status !== "active") return null;
  const rows = await tx
    .select({
      key: schema.roles.key,
      organizationId: schema.roles.organizationId,
      category: schema.roles.category,
      enabled: schema.roles.enabled,
    })
    .from(schema.membershipRoles)
    .innerJoin(schema.roles, eq(schema.membershipRoles.roleId, schema.roles.id))
    .where(
      and(
        eq(schema.membershipRoles.organizationId, organizationId),
        eq(schema.membershipRoles.membershipId, membershipId),
        // time-bound roles (on-call elevation, §7.2): only the live, unexpired grants count.
        or(
          isNull(schema.membershipRoles.expiresAt),
          gt(schema.membershipRoles.expiresAt, new Date()),
        ),
      ),
    );
  // The SAME authority `request.context.roles` derives from (M3 `membershipRoleKeysForOrg`, M6
  // `f2f-clinician-roles`): ENABLED roles only, minus a reserved platform key carried by a TENANT-owned row.
  const keys = new Set<string>();
  for (const r of rows) {
    if (
      r.enabled &&
      roleConfersKey({ organizationId: r.organizationId, key: r.key, category: r.category })
    )
      keys.add(r.key);
  }
  return [...keys].sort();
}
