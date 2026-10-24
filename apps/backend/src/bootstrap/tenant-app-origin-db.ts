// apps/backend/src/bootstrap/tenant-app-origin-db.ts — the database half of `tenantAppOrigin` (see ./tenant-app-origin).
// The slug is read under the organization's OWN tenant context (RLS keys on `app.org_id`), so no new privileged path is
// needed: the caller already acts for that organization, and an org-explicit read works from a worker or platform route.
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { type TenantAppOrigin, createTenantAppOrigin } from "./tenant-app-origin";
import { parseTenantBaseDomain } from "./tenant-host";

type EnvLike = Record<string, string | undefined>;

/** The global web origin: `WEB_APP_URL`, else `BETTER_AUTH_URL`, else the Vite dev origin outside production. */
export function webAppBaseUrlFromEnv(env: EnvLike = process.env): string | undefined {
  return (
    env.WEB_APP_URL ??
    env.BETTER_AUTH_URL ??
    (env.NODE_ENV === "production" ? undefined : "http://localhost:5173")
  );
}

export function createDbTenantAppOrigin(db: DbClient, env: EnvLike = process.env): TenantAppOrigin {
  return createTenantAppOrigin({
    baseDomain: parseTenantBaseDomain(env),
    fallbackOrigin: webAppBaseUrlFromEnv(env),
    portalOverride: env.PORTAL_APP_URL,
    async slugForOrg(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const result = await tx.execute(
          sql`SELECT slug FROM organization WHERE id = ${organizationId}::uuid`,
        );
        const row = (result as unknown as { rows?: { slug: string }[] }).rows?.[0];
        return row?.slug ?? null;
      });
    },
  });
}
