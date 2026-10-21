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

/**
 * `app.<base>` (a first label of exactly `app` over a base of at least two labels) is the "find my organization"
 * landing, not a tenant. A hostname heuristic rather than build config: the label is reserved by the slug rules, so
 * no tenant can ever collide with it, and the same build then serves every environment.
 */
export function isAppLandingHost(hostname: string): boolean {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
  return labels.length >= 3 && labels[0] === "app";
}
