// apps/backend/src/modules/02-identity/public-tenant-db.ts — the database half of the public tenant routes: the two narrow
// SECURITY DEFINER functions of migration 1146, callable before any organization is bound. Values are bound parameters.
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import type { PublicTenantRow, TenantLink } from "./routes/public-tenant-routes";

type Rows<T> = { rows?: T[] };

export function createDbPublicTenantLookups(db: DbClient): {
  resolvePublic(label: string): Promise<PublicTenantRow | null>;
  linksForEmail(email: string): Promise<readonly TenantLink[]>;
} {
  return {
    async resolvePublic(label) {
      const result = await db.execute(sql`SELECT status, display_name FROM resolve_tenant_public(${label})`);
      const row = (result as unknown as Rows<{ status: string; display_name: string | null }>).rows?.[0];
      return row ? { status: row.status, displayName: row.display_name } : null;
    },
    async linksForEmail(email) {
      const result = await db.execute(sql`SELECT slug, display_name FROM tenant_links_for_email(${email})`);
      const rows = (result as unknown as Rows<{ slug: string; display_name: string }>).rows ?? [];
      return rows.map((r) => ({ slug: r.slug, displayName: r.display_name }));
    },
  };
}
