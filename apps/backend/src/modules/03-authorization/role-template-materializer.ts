// apps/backend/src/modules/03-authorization/role-template-materializer.ts - the writer `ROLE_TEMPLATES` never had
// (GAP-006). Clones the tenant-assignable templates (and their default `role_permission` grants) into ONE org's
// `role` table, so a freshly provisioned tenant has roles, its first administrator can be handed `org_admin`, and an
// invitation's `proposedRoleKeys` resolve.
//
// The decisions (create-only, no platform authority, grants filtered to the permission mirror, `administrator` /
// `org_admin` get the non-platform catalog) are the pure planner's: packages/auth/src/roles/template-materialization.
// This file only reads the two inputs and applies the plan inside one `withOrgContext` transaction. Idempotent and
// safe to run on every boot: a second run finds every key present and writes nothing.
import { ROLE_TEMPLATES, planRoleTemplateMaterialization } from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";

/** The structural slice of a Drizzle transaction the materializer uses (so a caller already inside one can reuse it). */
export type MaterializerTx = Pick<DbClient, "select" | "insert">;

export interface RoleTemplateMaterialization {
  readonly rolesCreated: readonly string[];
  readonly grantsCreated: number;
  /** Template grant keys the permission mirror does not hold (skipped; the mirror is the FK target). */
  readonly skippedPermissionKeys: readonly string[];
}

/** Materialize inside an open org-scoped transaction (`app.org_id` already set to `organizationId`). */
export async function materializeRoleTemplatesInTx(
  tx: MaterializerTx,
  organizationId: string,
): Promise<RoleTemplateMaterialization> {
  const existing = await tx
    .select({ key: schema.roles.key })
    .from(schema.roles)
    .where(eq(schema.roles.organizationId, organizationId));
  const mirror = await tx
    .select({ key: schema.permissions.key, category: schema.permissions.category })
    .from(schema.permissions);
  const plan = planRoleTemplateMaterialization({
    templates: ROLE_TEMPLATES,
    existingRoleKeys: new Set(existing.map((r) => r.key)),
    mirror,
  });

  const rolesCreated: string[] = [];
  const skipped = new Set<string>();
  let grantsCreated = 0;
  for (const role of plan) {
    // ON CONFLICT DO NOTHING: a concurrent materialization (boot backfill racing the first-admin accept) that
    // inserted this key first leaves `inserted` empty, and this run then grants nothing for it.
    const inserted = await tx
      .insert(schema.roles)
      .values({
        organizationId,
        key: role.key,
        name: role.name,
        category: role.category,
        scopeLevel: role.scopeLevel,
        systemDefault: role.systemDefault,
        systemLocked: role.systemLocked,
        description: role.description,
        enabled: true,
      })
      .onConflictDoNothing({ target: [schema.roles.organizationId, schema.roles.key] })
      .returning({ id: schema.roles.id });
    const created = inserted[0];
    if (!created) continue;
    rolesCreated.push(role.key);
    for (const key of role.missingPermissionKeys) skipped.add(key);
    if (role.permissionKeys.length === 0) continue;
    const grants = await tx
      .insert(schema.rolePermissions)
      .values(
        role.permissionKeys.map((permissionKey) => ({
          organizationId,
          roleId: created.id,
          permissionKey,
        })),
      )
      .onConflictDoNothing({
        target: [schema.rolePermissions.roleId, schema.rolePermissions.permissionKey],
      })
      .returning({ id: schema.rolePermissions.id });
    grantsCreated += grants.length;
  }
  return { rolesCreated, grantsCreated, skippedPermissionKeys: [...skipped].sort() };
}

/** Materialize for one org in its own transaction (provisioning step, boot backfill). */
export async function materializeRoleTemplatesForOrg(
  db: DbClient,
  organizationId: string,
): Promise<RoleTemplateMaterialization> {
  return withOrgContext<DbClient, RoleTemplateMaterialization>(
    db,
    { organizationId, userId: "" },
    (tx) => materializeRoleTemplatesInTx(tx, organizationId),
  );
}
