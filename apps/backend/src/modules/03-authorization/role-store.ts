// apps/backend/src/modules/03-authorization — the PRODUCTION RoleStore (M3 §3.4 / §7.6).
//
// The role catalog routes (GET /api/v1/roles, POST/PATCH/DELETE) run through an injected RoleStore.
// This is the live Drizzle implementation over the M3-owned `role` + `role_permission` tables, run
// inside `withOrgContext` so RLS scopes every row by `app.org_id` (system templates are org_id NULL and
// readable in every scope; a tenant's own rows scope to its org). M3 may import @wardenx/db (dependsOn 1,
// added with the effective-permission store) so the Drizzle store lives in the module dir.
//
// `customized` = the row is org-owned (a tenant clone/edit) rather than a platform template (org_id NULL).
// The route layer enforces the `system_locked` CoP floor (RoleLockedError) before calling the store; the
// store performs the writes.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import type { ScopeLevel } from "@wardenx/auth";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { RoleStore, RoleView } from "./authz-ports";

interface RoleRow {
  id: string;
  organizationId: string | null;
  key: string;
  name: string;
  category: string;
  scopeLevel: string;
  systemDefault: boolean;
  systemLocked: boolean;
  enabled: boolean;
}

/** Attach each role's granted permission keys (`role_permission`) and project to a RoleView[]. */
async function toViews(
  tx: { select: DbClient["select"] },
  rows: RoleRow[],
): Promise<RoleView[]> {
  if (rows.length === 0) return [];
  const roleIds = rows.map((r) => r.id);
  const perms = await tx
    .select({ roleId: schema.rolePermissions.roleId, key: schema.rolePermissions.permissionKey })
    .from(schema.rolePermissions)
    .where(inArray(schema.rolePermissions.roleId, roleIds));
  const byRole = new Map<string, string[]>();
  for (const p of perms) {
    const keys = byRole.get(p.roleId);
    if (keys) keys.push(p.key);
    else byRole.set(p.roleId, [p.key]);
  }
  return rows.map((r) => ({
    roleId: r.id,
    organizationId: r.organizationId,
    key: r.key,
    name: r.name,
    category: r.category,
    scopeLevel: r.scopeLevel as ScopeLevel,
    systemDefault: r.systemDefault,
    systemLocked: r.systemLocked,
    enabled: r.enabled,
    customized: r.organizationId !== null, // a tenant-owned row is a customization of the catalog
    permissionKeys: byRole.get(r.id) ?? [],
  }));
}

const ROLE_COLUMNS = {
  id: schema.roles.id,
  organizationId: schema.roles.organizationId,
  key: schema.roles.key,
  name: schema.roles.name,
  category: schema.roles.category,
  scopeLevel: schema.roles.scopeLevel,
  systemDefault: schema.roles.systemDefault,
  systemLocked: schema.roles.systemLocked,
  enabled: schema.roles.enabled,
} as const;

/** Build the live RoleStore over the pooled Drizzle client. */
export function createDbRoleStore(db: DbClient): RoleStore {
  const ctx = (orgId: string) => ({ organizationId: orgId, userId: "" });

  return {
    async listForOrg(organizationId: string): Promise<RoleView[]> {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        // Platform templates (org_id NULL) + this org's own roles.
        // ⚠ KNOWN GAP (surfaced by the wardenx_app-role test harness): the `role_org` RLS policy is
        // `organization_id = app.org_id`, so under the real wardenx_app role the NULL-org TEMPLATE rows
        // are filtered out — the catalog would show only the org's own roles. Fix is a policy change
        // (`OR organization_id IS NULL`) or seeding templates per-org; tracked as a follow-up. The
        // explicit predicate below is correct under a BYPASSRLS/platform connection.
        const rows = (await tx
          .select(ROLE_COLUMNS)
          .from(schema.roles)
          .where(
            or(isNull(schema.roles.organizationId), eq(schema.roles.organizationId, organizationId)),
          )) as RoleRow[];
        return toViews(tx, rows);
      });
    },

    async get(roleId: string): Promise<RoleView | null> {
      // By-id read under the AMBIENT request org (withOrgContextFromRequest) so RLS scopes by
      // app.org_id under wardenx_app; a system template (org_id NULL) stays visible in any scope.
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = (await tx
          .select(ROLE_COLUMNS)
          .from(schema.roles)
          .where(eq(schema.roles.id, roleId))
          .limit(1)) as RoleRow[];
        if (rows.length === 0) return null;
        return (await toViews(tx, rows))[0] ?? null;
      });
    },

    async createCustom(input): Promise<RoleView> {
      return withOrgContext(db, ctx(input.organizationId), async (tx) => {
        const inserted = (await tx
          .insert(schema.roles)
          .values({
            organizationId: input.organizationId,
            key: input.key,
            name: input.name,
            category: input.category as (typeof schema.roles.$inferInsert)["category"],
            scopeLevel: input.scopeLevel,
            systemDefault: false,
            systemLocked: false,
            enabled: true,
          })
          .returning(ROLE_COLUMNS)) as RoleRow[];
        const row = inserted[0]!;
        if (input.permissionKeys.length > 0) {
          await tx.insert(schema.rolePermissions).values(
            input.permissionKeys.map((key) => ({
              organizationId: input.organizationId,
              roleId: row.id,
              permissionKey: key,
            })),
          );
        }
        return (await toViews(tx, [row]))[0]!;
      });
    },

    async update(roleId, patch): Promise<RoleView> {
      const current = (await db.select(ROLE_COLUMNS).from(schema.roles).where(eq(schema.roles.id, roleId)).limit(1)) as RoleRow[];
      const row = current[0];
      if (!row) throw new Error(`role ${roleId} not found`);
      const orgId = row.organizationId ?? "";
      return withOrgContext(db, ctx(orgId), async (tx) => {
        const set: Record<string, unknown> = {};
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.enabled !== undefined) set.enabled = patch.enabled;
        if (Object.keys(set).length > 0) {
          await tx.update(schema.roles).set(set).where(eq(schema.roles.id, roleId));
        }
        if (patch.permissionKeys !== undefined) {
          await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
          if (patch.permissionKeys.length > 0) {
            await tx.insert(schema.rolePermissions).values(
              patch.permissionKeys.map((key) => ({
                organizationId: row.organizationId,
                roleId,
                permissionKey: key,
              })),
            );
          }
        }
        const updated = (await tx.select(ROLE_COLUMNS).from(schema.roles).where(eq(schema.roles.id, roleId)).limit(1)) as RoleRow[];
        return (await toViews(tx, updated))[0]!;
      });
    },

    async delete(roleId: string): Promise<void> {
      const current = (await db.select({ organizationId: schema.roles.organizationId }).from(schema.roles).where(eq(schema.roles.id, roleId)).limit(1)) as Array<{ organizationId: string | null }>;
      const orgId = current[0]?.organizationId ?? "";
      await withOrgContext(db, ctx(orgId), async (tx) => {
        await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
        await tx.delete(schema.roles).where(and(eq(schema.roles.id, roleId)));
      });
    },
  };
}
