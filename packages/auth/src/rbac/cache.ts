// @chartwarden/auth · rbac — the effective-permission cache (M3 — Authorization, M3-T06;
// spec §3.1 layout `rbac/cache.ts`, §2.5 side effects).
//
// The §2.2 pipeline resolves an actor's effective permission set on every request, so the
// resolve (`membership_role → role_permission`) is cached per (org, actor). The spec's
// production cache is Valkey-backed; this leaf package stays infra-agnostic and ships the
// `EffectivePermissionCache` PORT plus an in-memory default, exactly as the M2 session
// seam injects its store. Production registers a Valkey-backed implementation at boot.
//
// Two correctness rules this cache must honor:
//   • §2.5 invalidation — granting/revoking a role or editing a role's permission set must
//     drop the affected entries (`invalidate` / `invalidateOrg`), so a permission change is
//     not masked by a stale cache.
//   • §7.2 time-bound elevation — a cached set must never outlive the soonest
//     `membership_role.expires_at` it was built from, or an expired on-call grant would keep
//     being served from cache. The resolver caps the TTL (see `resolve.ts`); the cache
//     enforces per-entry expiry against an injected clock so the bound is real, not nominal.

/** Epoch-ms clock (injected for deterministic expiry tests; defaults to `Date.now`). */
export type Clock = () => number;

/**
 * The cache the effective-permission resolver reads through (§2.5). A PORT, not an
 * implementation: production injects a Valkey-backed instance at boot; tests and the slice
 * use the in-memory default below. Values are immutable permission sets keyed by
 * `effectivePermissionCacheKey(orgId, userId)`.
 */
export interface EffectivePermissionCache {
  /** The cached set, or `undefined` on miss / after expiry. */
  get(key: string): ReadonlySet<string> | undefined;
  /** Cache `value` under `key`; `ttlMs` (if given) bounds how long it may be served. */
  set(key: string, value: ReadonlySet<string>, ttlMs?: number): void;
  /** Drop one entry — a role grant/revoke for that actor (§2.5). */
  invalidate(key: string): void;
  /** Drop every entry for an org — a role's permission set was edited (§2.5). */
  invalidateOrg(orgId: string): void;
  /** Drop everything (boot reset / test isolation). */
  clear(): void;
}

/**
 * The cache key for an actor's effective permissions in one org. Org-first so
 * `invalidateOrg` is a cheap prefix match and the key cannot collide across tenants.
 */
export function effectivePermissionCacheKey(orgId: string, userId: string): string {
  return `${orgId}:${userId}`;
}

interface CacheEntry {
  value: ReadonlySet<string>;
  /** Epoch ms after which the entry is stale, or `null` for the default-TTL bound. */
  expiresAt: number | null;
}

export interface InMemoryCacheOptions {
  /** Injected clock (default `Date.now`) — lets expiry be asserted deterministically. */
  readonly clock?: Clock;
  /** Upper bound applied when `set` is called without an explicit `ttlMs` (default 5 min). */
  readonly defaultTtlMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches the spec's cache freshness target.

/**
 * In-memory `EffectivePermissionCache` (slice/test default). Single-process and clock-driven:
 * an entry past its `expiresAt` is treated as a miss and evicted on read, so the §7.2
 * time-bound bound holds without a background sweeper. Production swaps in Valkey.
 */
export function createInMemoryEffectivePermissionCache(
  options: InMemoryCacheOptions = {},
): EffectivePermissionCache {
  const clock = options.clock ?? Date.now;
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  const store = new Map<string, CacheEntry>();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== null && entry.expiresAt <= clock()) {
        store.delete(key); // expired (e.g. an on-call grant's window closed) → miss + evict.
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      // A non-positive TTL means "already stale" — don't cache, so the next read re-resolves.
      const effectiveTtl = ttlMs ?? defaultTtlMs;
      if (effectiveTtl <= 0) {
        store.delete(key);
        return;
      }
      store.set(key, { value, expiresAt: clock() + effectiveTtl });
    },
    invalidate(key) {
      store.delete(key);
    },
    invalidateOrg(orgId) {
      const prefix = `${orgId}:`;
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) store.delete(key);
      }
    },
    clear() {
      store.clear();
    },
  };
}
