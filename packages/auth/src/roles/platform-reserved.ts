// @chartwarden/auth · roles — GAP-003: platform authority is never tenant-mintable.
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
// GAP-096 adds the platform authority whose key does NOT carry the prefix: M32's `ai_safety_owner`
// (the cross-tenant AI kill switch / lifecycle authority, §4.7). It is reserved by exact key. ADR-0112 adds a second,
// `superadmin` (one platform-owned role that stands for `administrator`, `org_admin` and every platform role).
import { PLATFORM_DUTY_ROLE_KEYS, PLATFORM_OPS_ROLE_KEYS } from "./templates";

/** Key prefix reserved to platform-owned roles. */
export const RESERVED_PLATFORM_ROLE_PREFIX = "platform_";

/** The role platform operators hold in their home org; the SOURCE for the tenant alert-audience bindings. M34's
 *  alert-rules.ts mirrors this literal (it imports no runtime code) and a test pins the two together. */
export const PLATFORM_OPS_ROLE_KEY = "platform_ops";

/**
 * The platform-owned role bound to platform operators inside a tenant org purely so M36 `role_set`
 * alerts reach them (migration 1097; apps/backend bootstrap/bind-platform-staff.ts). Its one `role_permission`
 * row is the self-only `alert.inbox.self`, and it is deliberately NOT in PLATFORM_OPS_ROLE_KEYS / PLATFORM_GRANTABLE_ROLE_KEYS: no predicate admits it
 * and the operator CLI cannot grant it.
 */
export const PLATFORM_ALERT_AUDIENCE_ROLE_KEY = "platform_alert_audience";

/**
 * The one role that stands for every other. A membership bound to the platform-owned `superadmin` row
 * reads as `administrator`, `org_admin` and every {@link PLATFORM_GRANTABLE_ROLE_KEYS} key (see
 * {@link expandSuperadminRoles}), and holds the permission catalog less the keys withheld from the admin roles
 * (`effectivePermissionKeys`). It is the only way to hold all of them without binding each; it does NOT reach another
 * tenant's PHI (RLS, the consented support session and break-glass are untouched). Reserved by exact key like
 * `ai_safety_owner`, so no tenant row can carry it.
 */
export const SUPERADMIN_ROLE_KEY = "superadmin";

/** Platform-authority keys outside the `platform_` prefix, reserved by exact match (GAP-096). */
export const RESERVED_PLATFORM_ROLE_KEYS = ["ai_safety_owner", SUPERADMIN_ROLE_KEY] as const;

/**
 * The platform role keys an operator may GRANT (`scripts/db/platform-role.ts`): every key a platform
 * predicate reads. The six platform-ops templates (M2/M22/M26/M29/M34/M35), M34's
 * `platform_security_owner` alert audience, M32's `ai_safety_owner` and `superadmin` (ADR-0112). All are reserved, so none of
 * them confers anything unless it is bound through a platform-owned row.
 */
export const PLATFORM_GRANTABLE_ROLE_KEYS = [
  ...PLATFORM_OPS_ROLE_KEYS,
  ...PLATFORM_DUTY_ROLE_KEYS,
  "platform_security_owner",
  ...RESERVED_PLATFORM_ROLE_KEYS,
] as const;

export type PlatformGrantableRoleKey = (typeof PLATFORM_GRANTABLE_ROLE_KEYS)[number];

/** True when `key` is one of {@link PLATFORM_GRANTABLE_ROLE_KEYS}. */
export function isPlatformGrantableRoleKey(key: string): key is PlatformGrantableRoleKey {
  return (PLATFORM_GRANTABLE_ROLE_KEYS as readonly string[]).includes(key);
}

/** The two tenant admin roles `superadmin` supersedes: sysadmin's `administrator` and orgadmin's `org_admin`. */
const SUPERSEDED_ADMIN_ROLE_KEYS = ["administrator", "org_admin"] as const;

/**
 * The role keys an actor holding `roles` is treated as holding. Anyone without `superadmin` gets `roles`
 * back untouched; a holder additionally reads as `administrator`, `org_admin` and every platform-grantable
 * role, so every existing `hasRole` / `PLATFORM_OPS_ROLE_KEYS` predicate admits them without being edited
 * (many list `administrator` without `org_admin`, so both are needed to supersede both). Call it only on keys
 * that already passed {@link roleConfersKey}: a tenant row named `superadmin` never gets here.
 */
export function expandSuperadminRoles(roles: readonly string[]): readonly string[] {
  if (!roles.includes(SUPERADMIN_ROLE_KEY)) return roles;
  return [...new Set([...roles, ...SUPERSEDED_ADMIN_ROLE_KEYS, ...PLATFORM_GRANTABLE_ROLE_KEYS])];
}

/**
 * The role keys left once platform authority is withheld (CW-AC-22: a request from outside `PLATFORM_CONSOLE_ALLOWED_CIDRS`): every
 * reserved platform key goes ({@link isReservedPlatformRoleKey}, so `platform_alert_audience` too). A holder of `superadmin` also loses
 * the `administrator` and `org_admin` it was expanded into ({@link expandSuperadminRoles}): after expansion a held `org_admin` and a
 * superadmin's are the same key, so both go (fail closed). Pure; the input is not changed.
 */
export function withoutPlatformRoles(roles: readonly string[]): readonly string[] {
  const droppedWithSuperadmin: readonly string[] = roles.includes(SUPERADMIN_ROLE_KEY)
    ? SUPERSEDED_ADMIN_ROLE_KEYS
    : [];
  return roles.filter(
    (role) => !isReservedPlatformRoleKey(role) && !droppedWithSuperadmin.includes(role),
  );
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
