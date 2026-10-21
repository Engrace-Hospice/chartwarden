// apps/backend/src/bootstrap/tenant-app-origin.ts — ADR-0049 / Phase 4: where an organization's emailed links point.
//
// With TENANT_BASE_DOMAIN set a tenant is served at `https://<slug>.<base>` (staff SPA at `/`, portal SPA at `/portal/`),
// so every link mailed on an organization's behalf must name THAT host. Unset, the origin is today's global one
// (`WEB_APP_URL ?? BETTER_AUTH_URL`; portal links `PORTAL_APP_URL ?? …`), unchanged. If the slug cannot be read the
// global origin is used rather than an invented host.

export interface TenantAppOriginDeps {
  /** `parseTenantBaseDomain()`; null is single-host mode. */
  readonly baseDomain: string | null;
  /** The global web origin (`WEB_APP_URL ?? BETTER_AUTH_URL ?? dev default`). */
  readonly fallbackOrigin: string | undefined;
  /** `PORTAL_APP_URL`; only honoured when `baseDomain` is null (portal is path-mounted on a tenant host). */
  readonly portalOverride?: string | undefined;
  /** The organization's CURRENT slug, or null when unknown. */
  slugForOrg(organizationId: string): Promise<string | null>;
}

export interface TenantAppOrigin {
  /** Origin of the staff SPA for this organization (no trailing slash). */
  appOrigin(organizationId: string): Promise<string | undefined>;
  /** Base URL of the portal SPA for this organization (no trailing slash); `<origin>/portal` on a tenant host. */
  portalOrigin(organizationId: string): Promise<string | undefined>;
}

const stripSlash = (url: string | undefined): string | undefined => url?.replace(/\/$/, "");

export function createTenantAppOrigin(deps: TenantAppOriginDeps): TenantAppOrigin {
  const fallback = stripSlash(deps.fallbackOrigin);
  const tenantOrigin = async (organizationId: string): Promise<string | undefined> => {
    if (!deps.baseDomain) return undefined;
    try {
      const slug = await deps.slugForOrg(organizationId);
      return slug ? `https://${slug}.${deps.baseDomain}` : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async appOrigin(organizationId) {
      return (await tenantOrigin(organizationId)) ?? fallback;
    },
    async portalOrigin(organizationId) {
      const tenant = await tenantOrigin(organizationId);
      if (tenant) return `${tenant}/portal`;
      return stripSlash(deps.baseDomain ? undefined : deps.portalOverride) ?? fallback;
    },
  };
}
