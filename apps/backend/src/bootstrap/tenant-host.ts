// apps/backend/src/bootstrap/tenant-host.ts — ADR-0049 D1/D2/D6: per-tenant subdomains.
//
// A tenant is served at `<slug>.<TENANT_BASE_DOMAIN>`. The host is a ROUTING and CONSISTENCY signal, never an
// authorization source: the tenant for a request is still `session.activeOrganizationId`, and this guard only
// REFUSES when the host's organization disagrees with it. A forged or misrouted `Host` can therefore cause a
// refusal, never widen access, and the host never reaches `withOrgContext` (RLS keys on the session's org).
//
// Unset `TENANT_BASE_DOMAIN` is single-host mode (today's behaviour, and the demo): no guard is built.
import { ChartWardenError, classifyTenantHost } from "@chartwarden/types";

// The classifier lives in @chartwarden/types so packages/auth can share it; re-exported for this module's callers.
export { classifyTenantHost };
export type { TenantHostClass } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

type EnvLike = Record<string, string | undefined>;

export const TENANT_BASE_DOMAIN_ENV = "TENANT_BASE_DOMAIN";

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MISS_TTL_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const REDIRECT_PERMANENT_KEEP_METHOD = 308;
/** A registrable domain: two or more RFC 1123 labels, lower-case. No scheme, port, path, wildcard or leading dot. */
const BASE_DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The configured base domain, or null (single-host mode). Throws on a malformed value: it is an operator error. */
export function parseTenantBaseDomain(env: EnvLike = process.env): string | null {
  const raw = env[TENANT_BASE_DOMAIN_ENV]?.trim().toLowerCase();
  if (!raw) return null;
  if (!BASE_DOMAIN_PATTERN.test(raw)) {
    throw new Error(`${TENANT_BASE_DOMAIN_ENV} must be a bare domain such as chartwarden.com (got "${raw}")`);
  }
  return raw;
}

export interface TenantHostResolution {
  readonly organizationId: string;
  /** The organization's CURRENT slug (differs from the requested label when `viaAlias`). */
  readonly slug: string;
  readonly status: string;
  readonly viaAlias: boolean;
}

export interface TenantHostResolver {
  resolve(label: string): Promise<TenantHostResolution | null>;
}

export interface CachingTenantHostResolver extends TenantHostResolver {
  /** Drop every entry that names this organization (call on suspend / close / activate / rename). */
  invalidateOrganization(organizationId: string): void;
  size(): number;
}

export interface TenantHostCacheOptions {
  readonly ttlMs?: number;
  readonly missTtlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

interface CacheEntry {
  readonly value: TenantHostResolution | null;
  readonly expiresAt: number;
}

/**
 * In-process cache over a resolver: hits for `ttlMs`, misses for a shorter `missTtlMs` (an attacker-chosen
 * wildcard host must not cost a query per request, and a freshly provisioned tenant must not 404 for long).
 * Bounded per map: when full the oldest entry goes. Invalidation is per process; other instances serve the old
 * answer until the TTL runs out (60 s at most).
 */
export function createCachingTenantHostResolver(
  inner: TenantHostResolver,
  options: TenantHostCacheOptions = {},
): CachingTenantHostResolver {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const missTtlMs = options.missTtlMs ?? DEFAULT_MISS_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  // Hits and misses live in separate bounded maps: an attacker-chosen wildcard host fills only the miss map and
  // can never evict a real tenant's entry.
  const hits = new Map<string, CacheEntry>();
  const misses = new Map<string, CacheEntry>();
  // Bumped by every invalidation: a resolve that began before it must not write its (possibly stale) answer back.
  let generation = 0;

  const store = (map: Map<string, CacheEntry>, label: string, entry: CacheEntry): void => {
    map.delete(label);
    if (map.size >= maxEntries) {
      const oldest = map.keys().next();
      if (!oldest.done) map.delete(oldest.value);
    }
    map.set(label, entry);
  };

  return {
    async resolve(label) {
      const cached = hits.get(label) ?? misses.get(label);
      if (cached && cached.expiresAt > now()) return cached.value;
      const startedAt = generation;
      const value = await inner.resolve(label);
      if (startedAt !== generation) return value;
      if (value) {
        misses.delete(label);
        store(hits, label, { value, expiresAt: now() + ttlMs });
      } else {
        hits.delete(label);
        store(misses, label, { value, expiresAt: now() + missTtlMs });
      }
      return value;
    },
    invalidateOrganization(organizationId) {
      generation += 1;
      for (const [label, entry] of hits) {
        if (entry.value?.organizationId === organizationId) hits.delete(label);
      }
    },
    size: () => hits.size + misses.size,
  };
}

export interface TenantHostGuardDeps {
  /** `parseTenantBaseDomain()`; null builds no guard. */
  readonly baseDomain: string | null;
  readonly resolver: TenantHostResolver;
}

export type TenantHostGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined>;

/**
 * The `onRequest` guard, registered AFTER authenticate. `request.hostname` is the socket `Host` unless the TCP
 * peer is one of TRUSTED_PROXY_CIDRS (Fastify's `trustProxy`), so `X-Forwarded-Host` from anyone else is ignored
 * and no tenant-identifying header is read at all.
 *
 * Outside a tenant host (the apex, reserved hosts, other domains) it does nothing, so the demo host, health
 * probes and the operator console are unaffected.
 */
export function createTenantHostGuard(deps: TenantHostGuardDeps): TenantHostGuard | null {
  const { baseDomain, resolver } = deps;
  if (!baseDomain) return null;

  return async (request, reply) => {
    const host = classifyTenantHost(request.hostname, baseDomain);
    if (host.kind === "invalid") throw tenantHostUnknown();
    if (host.kind !== "tenant") return undefined;

    const resolved = await resolver.resolve(host.label);
    if (!resolved) throw tenantHostUnknown();

    if (resolved.viaAlias) {
      const target = `https://${resolved.slug}.${baseDomain}${request.url}`;
      return reply.redirect(target, REDIRECT_PERMANENT_KEEP_METHOD);
    }
    if (resolved.status === "closed") {
      throw new ChartWardenError("TENANT_CLOSED", "this organization is no longer on ChartWarden", 410);
    }
    if (resolved.status === "suspended") {
      throw new ChartWardenError("TENANT_SUSPENDED", "this organization is suspended", 403);
    }

    const sessionOrg = request.context.organizationId;
    if (sessionOrg && sessionOrg !== resolved.organizationId) {
      throw new ChartWardenError(
        "TENANT_HOST_MISMATCH",
        "this session belongs to a different organization; sign in on that organization's address",
        403,
      );
    }
    request.context.attributes ??= {};
    request.context.attributes.tenantHostOrgId = resolved.organizationId;
    return undefined;
  };
}

function tenantHostUnknown(): ChartWardenError {
  return new ChartWardenError("TENANT_HOST_UNKNOWN", "no organization is served at this address", 404);
}
