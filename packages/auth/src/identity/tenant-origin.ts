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
      if (
        parsed.protocol !== "https:" ||
        parsed.port !== "" ||
        parsed.origin !== origin.toLowerCase().replace(/\/$/, "")
      )
        return false;
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
 * any look-alike, or a tenant the recipient does not belong to, leaves the link on its own origin). Never throws: any doubt
 * returns the URL unchanged.
 *
 * A link that stays on its own origin must not carry the requester's origin in its `callbackURL`: the token is delivered to
 * that callback after the reset, so a forged `Origin` naming a real tenant would otherwise steer a non-member's reset
 * token to that tenant's host. In tenant mode those callbacks are pinned to the link's origin.
 */
export async function rewriteLinkToRequestOrigin(
  url: string,
  request: Request | undefined,
  matcher: TenantOriginMatcher | undefined,
  email: string,
  mayUseHost: ((email: string, host: string) => Promise<boolean>) | undefined,
): Promise<string> {
  if (!matcher) return url;
  return (
    (await rewriteOntoRequestHost(url, request, matcher, email, mayUseHost)) ??
    pinCallbacksToLinkOrigin(url)
  );
}

async function rewriteOntoRequestHost(
  url: string,
  request: Request | undefined,
  matcher: TenantOriginMatcher,
  email: string,
  mayUseHost: ((email: string, host: string) => Promise<boolean>) | undefined,
): Promise<string | null> {
  const origin = request?.headers.get("origin");
  if (!request || !origin || !mayUseHost) return null;
  try {
    const requestHost = request.headers.get("host")?.toLowerCase();
    if (!requestHost || new URL(origin).host !== requestHost) return null;
    if (!(await matcher.isTrusted(origin))) return null;
    // The link goes to the recipient's own tenant, never to a host the requester merely named: the recipient must
    // hold an active membership there (a forged Origin for another real tenant cannot steer someone else's link).
    if (!(await mayUseHost(email, requestHost))) return null;
    const link = new URL(url);
    return `${new URL(origin).origin}${link.pathname}${link.search}${link.hash}`;
  } catch {
    return null;
  }
}

const CALLBACK_PARAMS = ["callbackURL", "errorCallbackURL"] as const;

/** The URL with any absolute `callbackURL` / `errorCallbackURL` moved onto the link's own origin; the same string when nothing needs moving. */
function pinCallbacksToLinkOrigin(url: string): string {
  try {
    const link = new URL(url);
    let changed = false;
    for (const key of CALLBACK_PARAMS) {
      const value = link.searchParams.get(key);
      if (!value) continue;
      let target: URL;
      try {
        target = new URL(value);
      } catch {
        continue; // a relative callback resolves against the link's own origin
      }
      if (target.origin === link.origin) continue;
      link.searchParams.set(key, `${link.origin}${target.pathname}${target.search}${target.hash}`);
      changed = true;
    }
    return changed ? link.toString() : url;
  } catch {
    return url;
  }
}
