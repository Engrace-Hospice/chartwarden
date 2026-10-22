import type { ApiClient } from "@chartwarden/ui";

// ADR-0049 Phase 4: the organization this HOST serves, or null. The route answers 404 on the demo/single-host and
// on a non-tenant host, so null means "behave as today"; a network or server failure is also null (never blocks
// sign-in). The caller can only tell "tenant host" from "not" - which is all the sign-in page and the picker need.
export interface TenantInfo {
  readonly status: string;
  readonly displayName?: string;
}

export async function fetchTenantInfo(client: ApiClient): Promise<TenantInfo | null> {
  try {
    const { data } = await client.GET("/api/v1/public/tenant");
    if (!data || typeof data.status !== "string") return null;
    return data.displayName
      ? { status: data.status, displayName: data.displayName }
      : { status: data.status };
  } catch {
    return null;
  }
}

/** Build-time `VITE_TENANT_BASE_DOMAIN` (the same value as the backend's `TENANT_BASE_DOMAIN`); unset on the demo. */
const BUILD_TENANT_BASE_DOMAIN: string | undefined = import.meta.env?.VITE_TENANT_BASE_DOMAIN;

/**
 * `app.<base>` is the "find my organization" landing, not a tenant: the label is reserved by the slug rules, so no
 * tenant can collide with it. It is matched EXACTLY against the configured base domain - never by hostname shape - so a
 * single-host deployment that happens to live at `app.example.com` is not hijacked. No base domain => never the landing.
 */
export function isAppLandingHost(
  hostname: string,
  baseDomain: string | undefined = BUILD_TENANT_BASE_DOMAIN,
): boolean {
  const base = baseDomain?.trim().toLowerCase().replace(/\.$/, "");
  if (!base) return false;
  return hostname.toLowerCase().replace(/\.$/, "") === `app.${base}`;
}
