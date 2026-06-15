// @wardenx/auth · rbac — the RBAC engine (M3 — Authorization, M3-T06; spec §2.2, §7.2).
//
// The §2.2 pipeline step "Resolve effective permissions: membership_role → role_permission
// for active_organization_id". `require-role.ts` (M3-T05) gates on this set through the
// injected `EffectivePermissionResolver` seam and denies on miss; THIS file is the real,
// cached resolver M3-T05's TODO pointed at. It computes an actor's effective permission set
// from their active role grants and registers itself via `setEffectivePermissionResolver`.
//
// `packages/auth` stays infra-agnostic (like the M2 session seam): the resolver reads grants
// through an injected `EffectivePermissionStore` PORT. Production injects the store that runs
// `membership_role ⋈ role ⋈ role_permission` under `withOrgContext` (so RLS scopes the read
// by `app.org_id`); the slice/tests use the in-memory store below. No `@wardenx/db` runtime
// import crosses this leaf — the import boundary (.dependency-cruiser.cjs) stays clean.
//
// Two resolution rules, both load-bearing:
//   • `role.enabled` — a disabled role contributes nothing (§2.3.1 lifecycle).
//   • `membership_role.expires_at` — a time-bound grant (on-call/locum/interim, §7.2) is
//     dropped once expired. The same request, same role, same RLS denies one minute after the
//     window closes — the RBAC half of §7.2 (the `oncall_shift_active` ABAC predicate is M3-T07).
//     The cache TTL is capped by the soonest upcoming expiry so caching cannot serve a grant
//     past its window.
import type { HttpRequestContext } from "@wardenx/types";
import {
  type Clock,
  type EffectivePermissionCache,
  createInMemoryEffectivePermissionCache,
  effectivePermissionCacheKey,
} from "./cache";
import {
  type EffectivePermissionResolver,
  resetEffectivePermissionResolver,
  setEffectivePermissionResolver,
} from "./require-role";

/**
 * One role granted to a membership, as the resolver needs it: the role's `enabled` flag,
 * the grant's `expires_at` (NULL = permanent), and the permission keys the role grants
 * (`role_permission` → `permission.key`). The production store assembles these from M3's own
 * tables under RLS; the in-memory store is seeded with them directly.
 */
export interface RoleGrant {
  /** `role.key` — for diagnostics / discipline derivation (the discipline predicate is M3-T07). */
  readonly roleKey: string;
  /** `role.enabled` — a disabled role grants nothing. */
  readonly enabled: boolean;
  /** `membership_role.expires_at` — `null` for permanent grants; a Date for time-bound ones (§7.2). */
  readonly expiresAt: Date | null;
  /** The permission keys this role grants (`role_permission.permission_key`). */
  readonly permissionKeys: readonly string[];
}

/**
 * Loads an actor's active role grants for one org (§2.2). A PORT: production runs the
 * `membership_role ⋈ role ⋈ role_permission` query under `withOrgContext` so RLS scopes it
 * to `app.org_id`; the in-memory implementation below serves the slice and tests. Keyed by
 * (orgId, userId) because the request context carries the actor + active org, not a
 * membership id.
 */
export interface EffectivePermissionStore {
  loadGrants(orgId: string, userId: string): Promise<RoleGrant[]> | RoleGrant[];
}

/** The set of effective permission keys plus the soonest future grant expiry (for TTL capping). */
export interface ResolvedPermissions {
  readonly permissions: ReadonlySet<string>;
  /** Epoch ms of the soonest still-future `expires_at` among the contributing grants, or `null`. */
  readonly soonestExpiryMs: number | null;
}

/**
 * Pure core of the engine: fold active grants into an effective permission set at instant
 * `nowMs`. Drops disabled roles and expired time-bound grants (§7.2), and reports the soonest
 * still-future expiry so the caller can bound the cache TTL. Exported for direct unit testing.
 */
export function resolveEffectivePermissions(
  grants: readonly RoleGrant[],
  nowMs: number,
): ResolvedPermissions {
  const permissions = new Set<string>();
  let soonestExpiryMs: number | null = null;
  for (const grant of grants) {
    if (!grant.enabled) continue; // disabled role → no permissions (§2.3.1).
    if (grant.expiresAt !== null) {
      const expiryMs = grant.expiresAt.getTime();
      if (expiryMs <= nowMs) continue; // time-bound grant already closed (§7.2) → excluded.
      soonestExpiryMs = soonestExpiryMs === null ? expiryMs : Math.min(soonestExpiryMs, expiryMs);
    }
    for (const key of grant.permissionKeys) permissions.add(key);
  }
  return { permissions, soonestExpiryMs };
}

export interface EffectivePermissionResolverOptions {
  /** Cache to read/write through (default: a fresh in-memory cache). */
  readonly cache?: EffectivePermissionCache;
  /** Injected clock (default `Date.now`) — keeps expiry deterministic in tests. */
  readonly clock?: Clock;
  /** Default cache TTL when no nearer grant expiry bounds it (ms; default 5 min). */
  readonly defaultTtlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** A registered resolver plus the §2.5 invalidation hooks for role grant/revoke/edit. */
export interface RbacEngineHandle {
  readonly resolver: EffectivePermissionResolver;
  /** Drop one actor's cached set (role granted/revoked on their membership, §2.5). */
  invalidateActor(orgId: string, userId: string): void;
  /** Drop a whole org's cached sets (a role's permission set was edited, §2.5). */
  invalidateOrg(orgId: string): void;
}

/**
 * Build the cached effective-permission resolver over a grant store. On a request it returns
 * the cached set or resolves it from `store.loadGrants`, caching the result with a TTL bounded
 * by the soonest grant expiry (so §7.2 elevation drops on time even from cache). Pair with
 * `registerEffectivePermissionResolver` to install it as the contract's resolver at boot.
 */
export function createEffectivePermissionResolver(
  store: EffectivePermissionStore,
  options: EffectivePermissionResolverOptions = {},
): RbacEngineHandle {
  const clock = options.clock ?? Date.now;
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  const cache = options.cache ?? createInMemoryEffectivePermissionCache({ clock, defaultTtlMs });

  const resolver: EffectivePermissionResolver = async (context: HttpRequestContext) => {
    const key = effectivePermissionCacheKey(context.organizationId, context.userId);
    const cached = cache.get(key);
    if (cached) return cached;

    const grants = await store.loadGrants(context.organizationId, context.userId);
    const nowMs = clock();
    const { permissions, soonestExpiryMs } = resolveEffectivePermissions(grants, nowMs);

    // Cap the TTL by the soonest future expiry so an on-call grant cannot be served past its
    // window; otherwise use the default freshness bound.
    const ttlMs =
      soonestExpiryMs === null ? defaultTtlMs : Math.min(defaultTtlMs, soonestExpiryMs - nowMs);
    cache.set(key, permissions, ttlMs);
    return permissions;
  };

  return {
    resolver,
    invalidateActor(orgId, userId) {
      cache.invalidate(effectivePermissionCacheKey(orgId, userId));
    },
    invalidateOrg(orgId) {
      cache.invalidateOrg(orgId);
    },
  };
}

/**
 * Boot wiring: build the cached resolver and install it as the Authorization Contract's
 * `EffectivePermissionResolver` (flipping `requirePermission` from its fail-closed default to
 * real resolution). Returns the handle so the M3 module can drive §2.5 invalidation on role
 * grant/revoke/edit. `validateSeams()`-style boot registers this once.
 */
export function registerEffectivePermissionResolver(
  store: EffectivePermissionStore,
  options: EffectivePermissionResolverOptions = {},
): RbacEngineHandle {
  const handle = createEffectivePermissionResolver(store, options);
  setEffectivePermissionResolver(handle.resolver);
  return handle;
}

/** Restore the contract's fail-closed default resolver (boot reset / test isolation). */
export function resetRbacEngine(): void {
  resetEffectivePermissionResolver();
}

/**
 * In-memory `EffectivePermissionStore` (slice/test default), mirroring the M2 session store's
 * shape. Grants are keyed by (orgId, userId); `put` replaces an actor's grant list so tests
 * can model role grant/revoke without a DB. Org-scoped by construction: a lookup for a
 * different org returns no grants.
 */
export function createInMemoryEffectivePermissionStore(
  seed: Array<{ orgId: string; userId: string; grants: RoleGrant[] }> = [],
): {
  store: EffectivePermissionStore;
  put(orgId: string, userId: string, grants: RoleGrant[]): void;
} {
  const rows = new Map<string, RoleGrant[]>();
  const rowKey = (orgId: string, userId: string) => effectivePermissionCacheKey(orgId, userId);
  for (const row of seed) rows.set(rowKey(row.orgId, row.userId), row.grants);
  return {
    store: {
      loadGrants: (orgId, userId) => rows.get(rowKey(orgId, userId)) ?? [],
    },
    put: (orgId, userId, grants) => {
      rows.set(rowKey(orgId, userId), grants);
    },
  };
}
