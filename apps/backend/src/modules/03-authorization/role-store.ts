import type { ScopeLevel } from "@chartwarden/auth";
import { floorViolations, isSystemLocked } from "@chartwarden/auth";
// apps/backend/src/modules/03-authorization — the PRODUCTION RoleStore (M3 §3.4 / §7.6).
//
// The role catalog routes (GET /api/v1/roles, POST/PATCH/DELETE) run through an injected RoleStore.
// This is the live Drizzle implementation over the M3-owned `role` + `role_permission` tables, run
// inside `withOrgContext` so RLS scopes every row by `app.org_id` (system templates are org_id NULL and
// readable in every scope; a tenant's own rows scope to its org). M3 may import @chartwarden/db (dependsOn 1,
// added with the effective-permission store) so the Drizzle store lives in the module dir.
//
// `customized` = the row is org-owned (a tenant clone/edit) rather than a platform template (org_id NULL).
//
// F-093 — THE §3.4.1 FLOOR WAS ENFORCED IN THE TEST DOUBLE AND NOWHERE ELSE, AND EACH LAYER NAMED THE
// OTHER AS THE ENFORCER. This header said "the route layer enforces the `system_locked` CoP floor
// (RoleLockedError) before calling the store"; `authz-routes.ts` says the opposite — "the §3.4.1 floor
// check IN THE STORE is what refuses it for a system_locked role" — and its update handler only
// TRANSLATES a `RoleLockedError` into HTTP, never raises one. The store that raises it is
// `createInMemoryRoleStore` (authz-ports.ts), the slice every route test runs against. The store
// production mounts is this one, and it deleted and re-inserted `role_permission` unconditionally and
// deleted any role row it was handed.
//
// So on a live deployment `PATCH /api/v1/roles/:id` with `permissionKeys: []` stripped the Medical
// Director's `patient.read` / `cti.sign` / `idg.participate` / `order.cosign`, and `DELETE` removed the
// Compliance Officer role outright — the M03-F06 control that CoP 418.102, 418.64(a) and 418.52
// compliance rests on. Every unit and route test passed throughout, because they all exercise the
// double that has the check.
//
// The check keys on the role KEY (`isSystemLocked`), not on the `system_locked` COLUMN, and the column
// is deliberately only an additional arm. Nothing materializes the platform role templates into `role`:
// `ROLE_TEMPLATES` has no sync anywhere (the `permission` catalog has `db:sync:permissions`; roles have
// no sibling), so every row in the table is org-owned with `system_default`/`system_locked` FALSE —
// migration 0025 widened the read policy to admit org-NULL template rows that nothing creates. A
// column-only check would therefore have been a second inert control. Left as a stated finding: which
// component materializes the catalog, and whether the ≈60 `system_default` templates the spec's
// Appendix A enumerates (this file ships 13) come with it, is a provisioning decision.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { withOrgContext, withOrgContextFromRequest } from "@chartwarden/tenancy";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { RoleLockedError, type RoleStore, type RoleView } from "./authz-ports";

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
async function toViews(tx: { select: DbClient["select"] }, rows: RoleRow[]): Promise<RoleView[]> {
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

/**
 * Is this row a `system_locked` role? Two arms, because the two sources disagree today (F-093).
 *
 * `isSystemLocked(key)` is the CODE catalog — `SYSTEM_LOCKED_FLOORS`, the six CoP-required roles — and
 * it is the arm that actually fires: every `role` row in existence is org-owned with `system_locked`
 * FALSE, because nothing materializes the platform templates. The COLUMN arm is kept anyway so the
 * check does not become inert the moment a materializer lands and starts writing `system_locked = true`
 * for a key the code catalog has not (yet) locked. A tenant-owned row keyed `medical_director` IS the
 * Medical Director role for that tenant, whatever the column says.
 */
function lockedKey(row: Pick<RoleRow, "key" | "systemLocked">): boolean {
  return isSystemLocked(row.key) || row.systemLocked;
}

/**
 * §3.4.1 floor: a permission-set edit may not strip a locked role below its CoP-required minimum.
 * A rename or an enable/disable is untouched — the floor is about what the role GRANTS.
 */
function assertLockedRoleEditable(
  row: RoleRow,
  permissionKeys: readonly string[] | undefined,
): void {
  if (!permissionKeys || !lockedKey(row)) return;
  const stripped = floorViolations(row.key, permissionKeys);
  if (stripped.length > 0) {
    throw new RoleLockedError(
      "floor",
      `role '${row.key}' is system_locked; cannot strip CoP-required permission(s)`,
      stripped,
    );
  }
}

/**
 * The org this write scopes to. A platform template (org_id NULL) has none, and the previous
 * `row.organizationId ?? ""` handed `set_config('app.org_id', '')` to `withOrgContext`, where the
 * policy's `current_setting('app.org_id', true)::uuid` cast raises `22P02` — a tenant editing a
 * template got a raw invalid-input-syntax 500 instead of a refusal. Refuse it as what it is.
 */
function requireOrgScope(row: RoleRow): string {
  if (row.organizationId === null) {
    // REFUSED, not cloned. The in-memory slice models a template edit as clone-on-write ("editing a
    // default role marks it customized + materializes an org-owned row"), which is the product
    // behaviour — but this store would have UPDATED THE TEMPLATE ITSELF, mutating it for every tenant.
    // Refusing is the honest interim: no template row exists in any database (nothing materializes
    // `ROLE_TEMPLATES`), so clone-on-write would be a feature built for rows that do not exist, and
    // `POST /roles` (createCustom) is the working path to a tenant-owned role today.
    throw new RoleLockedError("template", "platform templates are not tenant-editable");
  }
  return row.organizationId;
}

/** Build the live RoleStore over the pooled Drizzle client. */
export function createDbRoleStore(db: DbClient): RoleStore {
  const ctx = (orgId: string) => ({ organizationId: orgId, userId: "" });

  return {
    async listForOrg(organizationId: string): Promise<RoleView[]> {
      return withOrgContext(db, ctx(organizationId), async (tx) => {
        // Platform templates (org_id NULL) + this org's own roles. The `role_org` read policy admits
        // both (migration 0025 widened USING to `org_id = app.org_id OR org_id IS NULL`), so templates
        // stay visible under the real chartwarden_app role; writes remain org-strict (WITH CHECK).
        const rows = (await tx
          .select(ROLE_COLUMNS)
          .from(schema.roles)
          .where(
            or(
              isNull(schema.roles.organizationId),
              eq(schema.roles.organizationId, organizationId),
            ),
          )) as RoleRow[];
        return toViews(tx, rows);
      });
    },

    async get(roleId: string): Promise<RoleView | null> {
      // By-id read under the AMBIENT request org (withOrgContextFromRequest) so RLS scopes by
      // app.org_id under chartwarden_app; a system template (org_id NULL) stays visible in any scope.
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

    // ONE transaction, under the AMBIENT request org, pre-read included (F-093). The pre-read used to
    // run on the bare pool: `db.select().where(eq(roles.id, roleId))` with no `withOrgContext` around
    // it, so `app.org_id` was unset, `current_setting('app.org_id', true)::uuid` was NULL, the policy
    // predicate was NULL and the read matched NOTHING — every `PATCH /api/v1/roles/:id` threw
    // `role <id> not found` as a raw 500 under real RLS. It looked fine in development because
    // `db:migrate` grants `chartwarden_app` BYPASSRLS there (it says so, loudly, on every run), which is
    // precisely the difference this suite is live to catch. `get` in this same file already used the
    // ambient form; update/delete did not.
    async update(roleId, patch): Promise<RoleView> {
      return withOrgContextFromRequest(db, async (tx) => {
        const current = (await tx
          .select(ROLE_COLUMNS)
          .from(schema.roles)
          .where(eq(schema.roles.id, roleId))
          .limit(1)) as RoleRow[];
        const row = current[0];
        if (!row) throw new Error(`role ${roleId} not found`);
        assertLockedRoleEditable(row, patch.permissionKeys);
        requireOrgScope(row);
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
        const updated = (await tx
          .select(ROLE_COLUMNS)
          .from(schema.roles)
          .where(eq(schema.roles.id, roleId))
          .limit(1)) as RoleRow[];
        return (await toViews(tx, updated))[0]!;
      });
    },

    async delete(roleId: string): Promise<void> {
      await withOrgContextFromRequest(db, async (tx) => {
        const current = (await tx
          .select(ROLE_COLUMNS)
          .from(schema.roles)
          .where(eq(schema.roles.id, roleId))
          .limit(1)) as RoleRow[];
        const row = current[0];
        // Absent is not deletable-by-default. The previous code read `organizationId ?? ""` from a
        // pre-read that (see update) matched nothing, then opened a context on the empty string — so a
        // DELETE either removed no rows and reported success, or died on `''::uuid`. Neither is "the
        // role is gone", and only one of them says anything at all.
        if (!row) throw new Error(`role ${roleId} not found`);
        if (lockedKey(row)) {
          throw new RoleLockedError("delete", `role '${row.key}' is system_locked; cannot delete`);
        }
        if (row.organizationId === null) {
          throw new RoleLockedError("template", "platform templates are not tenant-deletable");
        }
        await tx.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
        await tx.delete(schema.roles).where(and(eq(schema.roles.id, roleId)));
      });
    },
  };
}
