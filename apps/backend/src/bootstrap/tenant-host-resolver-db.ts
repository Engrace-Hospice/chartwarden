// apps/backend/src/bootstrap/tenant-host-resolver-db.ts — the database half of ADR-0049's host → organization lookup.
// Calls the narrow SECURITY DEFINER function `resolve_tenant_host` (migration 1145), which answers for the ONE label
// passed in and is callable before an organization is bound. The label is bound as a parameter, never interpolated.
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type { TenantHostResolution, TenantHostResolver } from "./tenant-host";

interface ResolveRow {
  organization_id: string;
  slug: string;
  status: string;
  via_alias: boolean;
}

export function createDbTenantHostResolver(db: DbClient): TenantHostResolver {
  return {
    async resolve(label) {
      const result = await db.execute(sql`SELECT * FROM resolve_tenant_host(${label})`);
      const row = (result as unknown as { rows?: ResolveRow[] }).rows?.[0];
      if (!row) return null;
      const resolution: TenantHostResolution = {
        organizationId: row.organization_id,
        slug: row.slug,
        status: row.status,
        viaAlias: row.via_alias,
      };
      return resolution;
    },
  };
}
