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
//
// GAP-096 adds the one platform authority whose key does NOT carry the prefix: M32's `ai_safety_owner`
// (the cross-tenant AI kill switch / lifecycle authority, §4.7). It is reserved by exact key.
import { PLATFORM_OPS_ROLE_KEYS } from "./templates";

/** Key prefix reserved to platform-owned roles. */
export const RESERVED_PLATFORM_ROLE_PREFIX = "platform_";

/** Platform-authority keys outside the `platform_` prefix, reserved by exact match (GAP-096). */
export const RESERVED_PLATFORM_ROLE_KEYS = ["ai_safety_owner"] as const;

/**
 * The platform role keys an operator may GRANT (`scripts/db/platform-role.ts`): every key a platform
 * predicate reads. The six platform-ops templates (M2/M22/M26/M29/M34/M35), M34's
 * `platform_security_owner` alert audience and M32's `ai_safety_owner`. All are reserved, so none of
 * them confers anything unless it is bound through a platform-owned row.
 */
export const PLATFORM_GRANTABLE_ROLE_KEYS = [
  ...PLATFORM_OPS_ROLE_KEYS,
  "platform_security_owner",
  ...RESERVED_PLATFORM_ROLE_KEYS,
] as const;

export type PlatformGrantableRoleKey = (typeof PLATFORM_GRANTABLE_ROLE_KEYS)[number];

/** True when `key` is one of {@link PLATFORM_GRANTABLE_ROLE_KEYS}. */
export function isPlatformGrantableRoleKey(key: string): key is PlatformGrantableRoleKey {
  return (PLATFORM_GRANTABLE_ROLE_KEYS as readonly string[]).includes(key);
}

/** The role category reserved to platform-owned roles. */
export const RESERVED_PLATFORM_ROLE_CATEGORY = "platform_staff";

/** True when `key` names platform authority (`platform_*` or an exact reserved key) and so may only
 *  live on a platform-owned role. */
export function isReservedPlatformRoleKey(key: string): boolean {
  return (
    key.startsWith(RESERVED_PLATFORM_ROLE_PREFIX) ||
    (RESERVED_PLATFORM_ROLE_KEYS as readonly string[]).includes(key)
  );
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
