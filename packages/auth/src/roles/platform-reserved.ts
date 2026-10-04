// @wardenx/auth · roles — GAP-003: platform authority is never tenant-mintable.
//
// Every platform predicate (M22 form-template publish, M26 cap constants, M29 queue ops, M34 tenant
// lifecycle, M35 platform billing) decides on a role KEY carried in `context.roles`. Tenants may create
// roles with any `^[a-z0-9_]+$` key (POST /api/v1/roles) and the unique index is (organization_id, key),
// so a tenant row named `platform_admin` did not collide with anything and satisfied all of them — a
// tenant admin could self-assign it and suspend or close another tenant.
//
// The rule, shared by the enrichment reader (packages/auth/src/rbac/drizzle-store.ts), the role-create
// route (M3) and the DB backstop (migration 0318): a `platform_*` key or a `platform_staff` category is
// reserved to PLATFORM-OWNED role rows (`organization_id IS NULL`). A tenant-owned row carrying one
// confers nothing. The whole `platform_` prefix is reserved rather than the six PLATFORM_OPS_ROLE_KEYS,
// because predicates already read keys outside that list (`platform_security_owner`).

/** Key prefix reserved to platform-owned roles. */
export const RESERVED_PLATFORM_ROLE_PREFIX = "platform_";

/** The role category reserved to platform-owned roles. */
export const RESERVED_PLATFORM_ROLE_CATEGORY = "platform_staff";

/** True when `key` names platform authority and so may only live on a platform-owned role. */
export function isReservedPlatformRoleKey(key: string): boolean {
  return key.startsWith(RESERVED_PLATFORM_ROLE_PREFIX);
}

/** True when a tenant may NOT create a role with this key/category. */
export function isTenantRoleReserved(role: { key: string; category: string }): boolean {
  return isReservedPlatformRoleKey(role.key) || role.category === RESERVED_PLATFORM_ROLE_CATEGORY;
}

/**
 * Whether an assigned role row may contribute its key to an actor's `roles`. Platform-owned rows
 * (`organizationId === null`) always may; a tenant-owned row may not carry reserved platform authority
 * (rows that predate the migration 0318 backstop are dropped here rather than trusted).
 */
export function roleConfersKey(role: {
  organizationId: string | null;
  key: string;
  category: string;
}): boolean {
  return role.organizationId === null || !isTenantRoleReserved(role);
}
