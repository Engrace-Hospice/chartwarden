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
