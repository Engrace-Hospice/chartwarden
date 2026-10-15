// @wardenx/auth · roles — the plan for materializing ROLE_TEMPLATES into one tenant's `role` rows (GAP-006).
//
// WHAT WAS MISSING. `ROLE_TEMPLATES` was a TypeScript catalog with NO writer: a tenant provisioned through M34
// started with an empty `role` table, the first-admin acceptance threw "org_admin role template is unavailable",
// and an admin's `proposedRoleKeys` resolved to nothing. Only the dev seed scripts ever created role rows.
//
// THIS FILE IS PURE: given the keys the org already has and the permission mirror the database holds, it returns
// the role rows to create and the grants each new row gets. The DB executor (apps/backend, M3) applies it inside
// one `withOrgContext` transaction. Properties the executor relies on:
//   - CREATE-ONLY. A role the org already has (by key) is never touched, and grants are planned only for roles
//     created now - a tenant's edits to a clone are never reverted by a later run (idempotent re-runs are no-ops).
//   - NO PLATFORM AUTHORITY. Platform-owned templates (`platform_*`, the `platform_staff` category) are not tenant
//     roles: migration 0318 forbids a tenant row carrying them, and they are never cloned here.
//   - GRANTS ARE FILTERED TO THE MIRROR. `role_permission.permission_key` has a foreign key to `permission`, so a
//     template key the mirror lacks is skipped (and reported) rather than failing the whole materialization.
//   - THE TWO FULL-CATALOG ROLES (`administrator`, `org_admin` - the latter supersedes the former) receive every
//     mirror key EXCEPT the `platform` category (cross-tenant authority is never a tenant admin's default) and the
//     keys in FULL_CATALOG_EXCLUDED_KEYS (`messaging.review`: the lifecycle review queue is a supervisory decision,
//     ADR-0065 D6 - a tenant may still grant it to any role it owns).
import { isTenantRoleReserved } from "./platform-reserved";
import type { RoleTemplate } from "./templates";

/** Template keys that receive the whole (non-platform) permission catalog. `org_admin` ⊇ `administrator`. */
export const FULL_CATALOG_ROLE_KEYS: ReadonlySet<string> = new Set(["administrator", "org_admin"]);

/** The permission category that is cross-tenant authority and never a tenant default grant. */
export const PLATFORM_PERMISSION_CATEGORY = "platform";

/** Keys withheld from the full-catalog roles: granted deliberately to a supervisory role, never by default (ADR-0065 D6). */
export const FULL_CATALOG_EXCLUDED_KEYS: ReadonlySet<string> = new Set(["messaging.review"]);

/** One permission-mirror row the planner needs. */
export interface MirrorPermission {
  readonly key: string;
  readonly category: string;
}

export interface PlannedRole {
  readonly key: string;
  readonly name: string;
  readonly category: RoleTemplate["category"];
  readonly scopeLevel: RoleTemplate["scopeLevel"];
  readonly systemDefault: boolean;
  readonly systemLocked: boolean;
  readonly description: string;
  /** Permission keys to grant, all present in the mirror. */
  readonly permissionKeys: readonly string[];
  /** Template grant keys the mirror does not have (skipped, surfaced to the operator). */
  readonly missingPermissionKeys: readonly string[];
}

/** The roles an org still needs, in template order. */
export function planRoleTemplateMaterialization(input: {
  readonly templates: readonly RoleTemplate[];
  readonly existingRoleKeys: ReadonlySet<string>;
  readonly mirror: readonly MirrorPermission[];
}): readonly PlannedRole[] {
  const mirrorKeys = new Set(input.mirror.map((p) => p.key));
  const fullCatalog = input.mirror
    .filter(
      (p) => p.category !== PLATFORM_PERMISSION_CATEGORY && !FULL_CATALOG_EXCLUDED_KEYS.has(p.key),
    )
    .map((p) => p.key)
    .sort();
  return input.templates
    .filter((t) => !isTenantRoleReserved({ key: t.key, category: t.category }))
    .filter((t) => !input.existingRoleKeys.has(t.key))
    .map((t): PlannedRole => {
      const wanted = FULL_CATALOG_ROLE_KEYS.has(t.key)
        ? fullCatalog
        : [...new Set([...t.floor, ...(t.grants ?? [])])];
      return {
        key: t.key,
        name: t.name,
        category: t.category,
        scopeLevel: t.scopeLevel,
        systemDefault: t.systemDefault,
        systemLocked: t.systemLocked,
        description: t.description,
        permissionKeys: wanted.filter((k) => mirrorKeys.has(k)),
        missingPermissionKeys: wanted.filter((k) => !mirrorKeys.has(k)),
      };
    });
}
