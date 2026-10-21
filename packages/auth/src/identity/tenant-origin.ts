// packages/auth/src/identity/tenant-origin.ts — ADR-0049 D6: tenant origins are matched by RULE, not by list.
//
// An origin is a tenant origin when it is exactly `https://<label>.<TENANT_BASE_DOMAIN>` (no port, path or
// userinfo; one label; not a reserved host) AND the label resolves to an organization that is not suspended or
// closed, or to a retired alias of one. This is the single predicate behind Better Auth's trusted origins, the
// passkey ceremony, step-up verification and the realtime handshake. It is NOT behind CORS: tenant hosts are
// same-origin, so M1's CORS allow-set stays the exact list.
//
// The resolver is a port (packages/auth takes no import edge on apps/backend); the backend's cached
// `TenantHostResolver` satisfies it structurally.
import { classifyTenantHost } from "@chartwarden/types";

export interface TenantOriginResolver {
  resolve(label: string): Promise<{ readonly status: string } | null>;
}

export interface TenantOriginMatcher {
  isTrusted(origin: string): Promise<boolean>;
}

const REFUSED_STATUSES: ReadonlySet<string> = new Set(["suspended", "closed"]);

export function createTenantOriginMatcher(deps: {
  /** `TENANT_BASE_DOMAIN`; null is single-host mode, where no tenant origin is trusted. */
  readonly baseDomain: string | null;
  readonly resolver: TenantOriginResolver;
}): TenantOriginMatcher {
  const { baseDomain, resolver } = deps;
  return {
    async isTrusted(origin) {
      if (!baseDomain) return false;
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        return false;
      }
      // `origin` must already be a bare origin: https, default port, no path / query / userinfo.
      if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.origin !== origin.toLowerCase().replace(/\/$/, "")) return false;
      const host = classifyTenantHost(parsed.hostname, baseDomain);
      if (host.kind !== "tenant") return false;
      const resolved = await resolver.resolve(host.label);
      return resolved !== null && !REFUSED_STATUSES.has(resolved.status);
    },
  };
}

/**
 * Phase 4 — Better Auth builds reset / magic-link URLs on its one `baseURL`. On a tenant host the link must open on
 * the host the person asked from, so swap the origin for the request's own — but only when that origin is a tenant
 * origin the matcher trusts AND is the very host the request arrived on (a forged `Origin` naming another tenant, or
 * any look-alike, leaves the link untouched). Never throws: any doubt returns the URL unchanged.
 */
export async function rewriteLinkToRequestOrigin(
  url: string,
  request: Request | undefined,
  matcher: TenantOriginMatcher | undefined,
): Promise<string> {
  const origin = request?.headers.get("origin");
  if (!request || !origin || !matcher) return url;
  try {
    const requestHost = request.headers.get("host")?.toLowerCase();
    if (!requestHost || new URL(origin).host !== requestHost) return url;
    if (!(await matcher.isTrusted(origin))) return url;
    const link = new URL(url);
    return `${new URL(origin).origin}${link.pathname}${link.search}${link.hash}`;
  } catch {
    return url;
  }
}
