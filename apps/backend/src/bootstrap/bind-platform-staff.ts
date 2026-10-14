// apps/backend/src/bootstrap/bind-platform-staff.ts — give every platform-ops operator an ACTIVE membership
// (bound to the platform-owned `platform_ops` role) in a freshly provisioned tenant org.
//
// WHY. M36's `role_set` resolver finds alert recipients with a `membership_role → role` join INSIDE the tenant
// org, and `platform_ops` is bound per membership. A new tenant has no platform-ops membership, so alerts that
// route at `role_set[platform_ops]` (stuck activation, oversized export hold, ...) were written and delivered
// to nobody.
//
// SCOPE OF THE GRANT. The binding is to the PLATFORM-OWNED role row (`organization_id IS NULL`, migration 0318/
// 0320), which carries no tenant permission keys: the membership confers the ABAC key and alert audience, not
// access to tenant data. Operators come from M34's existing SECURITY DEFINER reader (`m34_platform_role_holders`,
// user ids only), so no new privilege is opened. Writes run on the tenant pool under the new org's RLS scope.
// Idempotent: the partial unique index on (user, org) and the (membership, role) unique key make a re-run a no-op.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, sql } from "drizzle-orm";

export const PLATFORM_OPS_ROLE_KEY = "platform_ops";

export interface PlatformStaffBinding {
  /** Operators that now hold the role in the org (already-bound ones included). */
  readonly operators: number;
}

export async function bindPlatformStaffToOrg(
  db: DbClient,
  organizationId: string,
): Promise<PlatformStaffBinding> {
  const holders = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM m34_platform_role_holders(ARRAY[${PLATFORM_OPS_ROLE_KEY}]::text[])`,
  );
  const userIds = holders.rows.map((r) => r.user_id);
  if (userIds.length === 0) return { operators: 0 };

  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const [role] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          isNull(schema.roles.organizationId),
          eq(schema.roles.key, PLATFORM_OPS_ROLE_KEY),
          eq(schema.roles.enabled, true),
        ),
      )
      .limit(1);
    if (!role) return { operators: 0 };

    let bound = 0;
    for (const userId of userIds) {
      const inserted = await tx
        .insert(schema.memberships)
        .values({ userId, organizationId, status: "active", acceptedAt: new Date() })
        .onConflictDoNothing()
        .returning({ id: schema.memberships.id });
      const membershipId =
        inserted[0]?.id ??
        (
          await tx
            .select({ id: schema.memberships.id })
            .from(schema.memberships)
            .where(
              and(
                eq(schema.memberships.userId, userId),
                eq(schema.memberships.organizationId, organizationId),
                eq(schema.memberships.status, "active"),
              ),
            )
            .limit(1)
        )[0]?.id;
      // A pending/suspended pre-existing membership is left alone: this never reactivates anyone.
      if (!membershipId) continue;
      await tx
        .insert(schema.membershipRoles)
        .values({ organizationId, membershipId, roleId: role.id })
        .onConflictDoNothing();
      bound += 1;
    }
    return { operators: bound };
  });
}
