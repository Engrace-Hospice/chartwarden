// apps/backend/src/bootstrap/bind-platform-staff.ts — give every platform-ops operator an ACTIVE membership
// in a freshly provisioned tenant org, bound to the ZERO-permission platform-owned `platform_alert_audience` role.
//
// WHY. M36's `role_set` resolver finds alert recipients with a `membership_role → role` join INSIDE the tenant
// org. A new tenant has no operator membership, so alerts routed at `role_set[platform_alert_audience]` (stuck
// activation, oversized export hold) were written and delivered to nobody.
//
// SCOPE OF THE GRANT. The tenant binding is NOT `platform_ops`: that role carries `user.password.reset` /
// `user.deactivate`, and the tenant routes gate on requirePermission alone, so a bound operator could reset any
// tenant user's password. `platform_alert_audience` (migration 1097, organization_id IS NULL) has NO
// role_permission rows and is in no platform predicate's admit-set, so the binding confers nothing but delivery.
// Operators are still SOURCED from holders of `platform_ops` in their home org via M34's SECURITY DEFINER reader
// (`m34_platform_role_holders`: user ids + grant expiry only, globally deactivated users already excluded).
// The home-org grant's `expires_at` is copied onto the tenant binding. Each new binding writes an
// `m2.platform_staff.bound` audit event (system actor) in the same transaction. Writes run on the tenant pool
// under the new org's RLS scope.
//
// KNOWN GAPS. (1) Nothing reconciles on a home-org revoke/expiry-change/deactivation AFTER provisioning: a revoked
// operator keeps this (zero-permission) membership until a tenant admin removes it, and it still receives
// that tenant's platform alerts. (2) Failures are reported with process.emitWarning because no structured logger
// is plumbed into the seam hook.
// Idempotent, and it respects a deliberate removal: a user with ANY existing membership in the org is never
// touched again (a non-active one is skipped; an active one keeps whatever roles the tenant admin left it), so a
// retried provision never resurrects a revoked operator or re-adds a removed role.
import { randomUUID } from "node:crypto";
import { audit } from "@wardenx/audit";
import { PLATFORM_ALERT_AUDIENCE_ROLE_KEY } from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, sql } from "drizzle-orm";

/** Operators are sourced from holders of this role in their home org. */
export const PLATFORM_OPS_ROLE_KEY = "platform_ops";
/** The role they are bound with inside the tenant. Zero permissions. */
export const TENANT_BINDING_ROLE_KEY = PLATFORM_ALERT_AUDIENCE_ROLE_KEY;

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
  const holders = await db.execute<{ user_id: string; expires_at: Date | string | null }>(
    sql`SELECT user_id, expires_at FROM m34_platform_role_holders(ARRAY[${PLATFORM_OPS_ROLE_KEY}]::text[])`,
  );
  const operators = holders.rows.map((r) => ({
    userId: r.user_id,
    expiresAt: r.expires_at === null ? null : new Date(r.expires_at),
  }));
  if (operators.length === 0) return NONE;

  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const [role] = await tx
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(
        and(
          isNull(schema.roles.organizationId),
          eq(schema.roles.key, TENANT_BINDING_ROLE_KEY),
          eq(schema.roles.enabled, true),
        ),
      )
      .limit(1);
    if (!role) return NONE;

    let bound = 0;
    let skipped = 0;
    for (const { userId, expiresAt } of operators) {
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
      // An existing active membership is left alone: a retried provision must not re-add a role that a tenant
      // admin removed. (The bind is one transaction, so an active row without the role was not a half-bind.)
      if (existing.length > 0) {
        bound += 1;
        continue;
      }
      const [created] = await tx
        .insert(schema.memberships)
        .values({ userId, organizationId, status: "active", acceptedAt: new Date() })
        .returning({ id: schema.memberships.id });
      if (!created) continue;
      await tx
        .insert(schema.membershipRoles)
        .values({ organizationId, membershipId: created.id, roleId: role.id, expiresAt });
      await audit(
        tx,
        { organizationId, userId: null, actorKind: "system", correlationId: randomUUID() },
        {
          eventType: "m2.platform_staff.bound",
          resourceKind: "membership",
          resourceId: created.id,
          outcome: "success",
          retentionClass: "compliance",
          after: {
            operatorUserId: userId,
            roleKey: TENANT_BINDING_ROLE_KEY,
            organizationId,
            expiresAt: expiresAt?.toISOString() ?? null,
          },
        },
      );
      bound += 1;
    }
    return { operators: bound, skipped };
  });
}
