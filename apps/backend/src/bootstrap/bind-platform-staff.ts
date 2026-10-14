// apps/backend/src/bootstrap/bind-platform-staff.ts — give every platform-ops operator an ACTIVE membership
// (bound to the platform-owned `platform_ops` role) in a freshly provisioned tenant org.
//
// WHY. M36's `role_set` resolver finds alert recipients with a `membership_role → role` join INSIDE the tenant
// org, and `platform_ops` is bound per membership. A new tenant has no platform-ops membership, so alerts that
// route at `role_set[platform_ops]` (stuck activation, oversized export hold, ...) were written and delivered
// to nobody.
//
// SCOPE OF THE GRANT. The binding is to the PLATFORM-OWNED role row (`organization_id IS NULL`, migration 0318/
// 0320). That role carries only the platform-wide `user.deactivate` / `user.password.reset` keys (no PHI, patient
// or messaging keys), plus the ABAC key and the alert audience. KNOWN GAP: revoking `platform_ops` in the home org
// does not remove these tenant bindings (see the PR description); nothing reconciles them against the holders. Operators come from M34's existing SECURITY DEFINER reader (`m34_platform_role_holders`,
// user ids only), so no new privilege is opened. Writes run on the tenant pool under the new org's RLS scope.
// Idempotent, and it respects a deliberate removal: a user with ANY existing membership in the org that is not
// active (revoked, pending, suspended) is skipped, so a retried provision never resurrects a revoked operator.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, sql } from "drizzle-orm";

export const PLATFORM_OPS_ROLE_KEY = "platform_ops";

export interface PlatformStaffBinding {
  /** Operators now holding the role in the org (already-bound ones included). */
  readonly operators: number;
  /** Operators skipped because they already have a non-active membership in the org. */
  readonly skipped: number;
}

const NONE: PlatformStaffBinding = { operators: 0, skipped: 0 };

/**
 * Alert routing is best-effort, so a failure here must not block tenant provisioning (the org-available hook
 * makes the confirm `unavailable` and M34 retries forever); it degrades to "no operators bound" and warns.
 */
export async function bindPlatformStaffToOrg(
  db: DbClient,
  organizationId: string,
): Promise<PlatformStaffBinding> {
  try {
    return await bindOperators(db, organizationId);
  } catch (err) {
    process.emitWarning(
      `platform-staff binding failed for org ${organizationId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return NONE;
  }
}

async function bindOperators(db: DbClient, organizationId: string): Promise<PlatformStaffBinding> {
  const holders = await db.execute<{ user_id: string }>(
    sql`SELECT user_id FROM m34_platform_role_holders(ARRAY[${PLATFORM_OPS_ROLE_KEY}]::text[])`,
  );
  const userIds = holders.rows.map((r) => r.user_id);
  if (userIds.length === 0) return NONE;

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
    if (!role) return NONE;

    let bound = 0;
    let skipped = 0;
    for (const userId of userIds) {
      const existing = await tx
        .select({ id: schema.memberships.id, status: schema.memberships.status })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.userId, userId),
            eq(schema.memberships.organizationId, organizationId),
          ),
        );
      // Any non-active row (revoked by a tenant admin, pending, suspended) means leave this user alone.
      if (existing.some((m) => m.status !== "active")) {
        skipped += 1;
        continue;
      }
      const membershipId =
        existing[0]?.id ??
        (
          await tx
            .insert(schema.memberships)
            .values({ userId, organizationId, status: "active", acceptedAt: new Date() })
            .returning({ id: schema.memberships.id })
        )[0]?.id;
      if (!membershipId) continue;
      await tx
        .insert(schema.membershipRoles)
        .values({ organizationId, membershipId, roleId: role.id })
        .onConflictDoNothing();
      bound += 1;
    }
    return { operators: bound, skipped };
  });
}
