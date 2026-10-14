// apps/backend/src/bootstrap/bind-platform-staff.ts — give every platform-ops operator an ACTIVE membership
// in a tenant org, bound to the platform-owned `platform_alert_audience` role, and keep that set reconciled.
//
// WHY. M36's `role_set` resolver finds alert recipients with a `membership_role → role` join INSIDE the tenant
// org. A new tenant has no operator membership, so alerts routed at `role_set[platform_alert_audience]` (stuck
// activation, oversized export hold) were written and delivered to nobody.
//
// SCOPE OF THE GRANT. The tenant binding is NOT `platform_ops`: that role carries `user.password.reset` /
// `user.deactivate`, and the tenant routes gate on requirePermission alone, so a bound operator could reset any
// tenant user's password. `platform_alert_audience` (migration 1097, organization_id IS NULL) holds exactly one
// key, `alert.inbox.self` (the caller's OWN alert inbox / mark-read), and is in no platform predicate's admit-set,
// so the binding confers delivery plus reading one's own alerts and nothing else.
// Operators are SOURCED from holders of `platform_ops` in their home org via M34's SECURITY DEFINER reader
// (`m34_platform_role_holders`: user ids + grant expiry only, globally deactivated users already excluded).
// The home-org grant's `expires_at` is copied onto the tenant binding. Writes run on the tenant pool under the
// org's RLS scope; every change writes an `m2.platform_staff.*` audit event (system actor) in the same transaction.
//
// RECONCILE (`reconcilePlatformStaff`, boot only). Re-runs the same rules over every active org, so a bind that
// failed at provisioning, or an operator added later, is picked up on the next boot; and an operator who no longer
// holds `platform_ops` (revoked, deactivated, grant expired) has THEIR `platform_alert_audience` binding expired
// (expires_at = now). Only that one binding row is touched, never the membership or any other role. A binding
// whose operator holds `platform_ops` again is re-synced to the home grant's expiry.
// LIMITS: boot-only (no interval job exists for this); a deploy is the retry cadence.
//
// NEVER RESURRECTS. A user with ANY existing membership in the org is not re-created: a non-active one (revoked,
// pending, suspended) is skipped, and an active one that has no audience binding keeps whatever roles the tenant
// admin left it, so a tenant admin who removed the role is respected.
import { randomUUID } from "node:crypto";
import { audit } from "@wardenx/audit";
import { PLATFORM_ALERT_AUDIENCE_ROLE_KEY, PLATFORM_OPS_ROLE_KEY } from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, isNull, sql } from "drizzle-orm";

/** The role they are bound with inside the tenant. */
export const TENANT_BINDING_ROLE_KEY = PLATFORM_ALERT_AUDIENCE_ROLE_KEY;

export interface PlatformStaffBinding {
  /** Operators newly bound in this run. */
  readonly bound: number;
  /** Operators skipped because they already have a non-active membership in the org. */
  readonly skipped: number;
  /** Bindings expired because the operator no longer holds platform_ops (reconcile only). */
  readonly unbound: number;
  /** Existing bindings whose expiry was re-synced to the home grant (reconcile only). */
  readonly refreshed: number;
}

const NONE: PlatformStaffBinding = { bound: 0, skipped: 0, unbound: 0, refreshed: 0 };

interface Operator {
  readonly userId: string;
  readonly expiresAt: Date | null;
}

/** Where a failed bind/reconcile is reported. Defaults to a process warning until the app logger is plumbed in. */
export type PlatformStaffFailureSink = (fields: Record<string, unknown>, message: string) => void;

let reportFailure: PlatformStaffFailureSink = (fields, message) =>
  process.emitWarning(`${message} ${JSON.stringify(fields)}`);

/** Composition root: route failures to the structured app logger (the seam hook runs before it exists). */
export function setPlatformStaffFailureSink(sink: PlatformStaffFailureSink): void {
  reportFailure = sink;
}

function failure(organizationId: string, phase: "bind" | "reconcile", err: unknown): void {
  reportFailure(
    { organizationId, phase, err: err instanceof Error ? err.message : String(err) },
    "platform-staff binding failed; the org has no (or a stale) platform operator alert audience until the next boot reconcile",
  );
}

/**
 * Alert routing is best-effort, so a failure here must not block tenant provisioning (the org-available hook
 * makes the confirm `unavailable` and M34 retries forever); it is reported and `reconcilePlatformStaff` retries.
 */
export async function bindPlatformStaffToOrg(
  db: DbClient,
  organizationId: string,
): Promise<PlatformStaffBinding> {
  try {
    return await syncOrg(db, organizationId, await readOperators(db), false);
  } catch (err) {
    failure(organizationId, "bind", err);
    return NONE;
  }
}

/** Idempotent boot reconcile over the given orgs: late binds plus revoke/expiry sync. One org's failure is reported, not fatal. */
export async function reconcilePlatformStaff(
  db: DbClient,
  orgs: readonly { readonly organizationId: string }[],
): Promise<PlatformStaffBinding> {
  let operators: readonly Operator[];
  try {
    operators = await readOperators(db);
  } catch (err) {
    // Without the holder list nothing may be expired, so a read failure aborts the whole run.
    failure("*", "reconcile", err);
    return NONE;
  }
  let total = NONE;
  for (const { organizationId } of orgs) {
    try {
      const r = await syncOrg(db, organizationId, operators, true);
      total = {
        bound: total.bound + r.bound,
        skipped: total.skipped + r.skipped,
        unbound: total.unbound + r.unbound,
        refreshed: total.refreshed + r.refreshed,
      };
    } catch (err) {
      failure(organizationId, "reconcile", err);
    }
  }
  return total;
}

async function readOperators(db: DbClient): Promise<readonly Operator[]> {
  const holders = await db.execute<{ user_id: string; expires_at: Date | string | null }>(
    sql`SELECT user_id, expires_at FROM m34_platform_role_holders(ARRAY[${PLATFORM_OPS_ROLE_KEY}]::text[])`,
  );
  return holders.rows.map((r) => ({
    userId: r.user_id,
    expiresAt: r.expires_at === null ? null : new Date(r.expires_at),
  }));
}

const sameInstant = (a: Date | null, b: Date | null): boolean =>
  (a === null && b === null) || (a !== null && b !== null && a.getTime() === b.getTime());

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

async function syncOrg(
  db: DbClient,
  organizationId: string,
  operators: readonly Operator[],
  reconcile: boolean,
): Promise<PlatformStaffBinding> {
  // Provisioning with no operators has nothing to do; a reconcile must still run to expire stale bindings.
  if (operators.length === 0 && !reconcile) return NONE;

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

    const ctx = { organizationId, userId: null, actorKind: "system" as const };
    const synced = reconcile
      ? await syncExistingBindings(tx, organizationId, role.id, operators, ctx)
      : { unbound: 0, refreshed: 0 };

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
      if (existing.length > 0) continue;
      const [created] = await tx
        .insert(schema.memberships)
        .values({ userId, organizationId, status: "active", acceptedAt: new Date() })
        .returning({ id: schema.memberships.id });
      if (!created) continue;
      await tx
        .insert(schema.membershipRoles)
        .values({ organizationId, membershipId: created.id, roleId: role.id, expiresAt });
      await auditBinding(tx, ctx, "m2.platform_staff.bound", created.id, userId, expiresAt);
      bound += 1;
    }
    return { bound, skipped, ...synced };
  });
}

/** Reconcile the bindings that already exist: expire the revoked operators', re-sync a returning operator's expiry. */
async function syncExistingBindings(
  tx: Tx,
  organizationId: string,
  roleId: string,
  operators: readonly Operator[],
  ctx: { organizationId: string; userId: null; actorKind: "system" },
): Promise<{ unbound: number; refreshed: number }> {
  const byUser = new Map(operators.map((o) => [o.userId, o]));
  const now = new Date();
  const bindings = await tx
    .select({
      id: schema.membershipRoles.id,
      membershipId: schema.membershipRoles.membershipId,
      expiresAt: schema.membershipRoles.expiresAt,
      userId: schema.memberships.userId,
      status: schema.memberships.status,
    })
    .from(schema.membershipRoles)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.membershipRoles.membershipId))
    .where(
      and(
        eq(schema.membershipRoles.organizationId, organizationId),
        eq(schema.membershipRoles.roleId, roleId),
      ),
    );
  let unbound = 0;
  let refreshed = 0;
  for (const b of bindings) {
    const op = byUser.get(b.userId);
    if (!op) {
      if (b.expiresAt !== null && b.expiresAt <= now) continue; // already ended
      await tx
        .update(schema.membershipRoles)
        .set({ expiresAt: now })
        .where(eq(schema.membershipRoles.id, b.id));
      await auditBinding(tx, ctx, "m2.platform_staff.unbound", b.membershipId, b.userId, now);
      unbound += 1;
    } else if (b.status === "active" && !sameInstant(b.expiresAt, op.expiresAt)) {
      await tx
        .update(schema.membershipRoles)
        .set({ expiresAt: op.expiresAt })
        .where(eq(schema.membershipRoles.id, b.id));
      await auditBinding(
        tx,
        ctx,
        "m2.platform_staff.bound",
        b.membershipId,
        b.userId,
        op.expiresAt,
      );
      refreshed += 1;
    }
  }
  return { unbound, refreshed };
}

async function auditBinding(
  tx: Tx,
  ctx: { organizationId: string; userId: null; actorKind: "system" },
  eventType: "m2.platform_staff.bound" | "m2.platform_staff.unbound",
  membershipId: string,
  operatorUserId: string,
  expiresAt: Date | null,
): Promise<void> {
  await audit(
    tx,
    { ...ctx, correlationId: randomUUID() },
    {
      eventType,
      resourceKind: "membership",
      resourceId: membershipId,
      outcome: "success",
      retentionClass: "compliance",
      after: {
        operatorUserId,
        roleKey: TENANT_BINDING_ROLE_KEY,
        organizationId: ctx.organizationId,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
    },
  );
}
