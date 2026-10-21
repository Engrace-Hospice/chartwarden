// apps/backend/src/modules/02-identity/public-tenant-db.ts — the database half of the public tenant routes: the two narrow
// SECURITY DEFINER functions of migration 1146, callable before any organization is bound. Values are bound parameters.
import type { DbClient } from "@chartwarden/db";
import { classifyTenantHost } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import type { PublicTenantRow, TenantLink } from "./routes/public-tenant-routes";

type Rows<T> = { rows?: T[] };

export function createDbPublicTenantLookups(db: DbClient): {
  resolvePublic(label: string): Promise<PublicTenantRow | null>;
  linksForEmail(email: string): Promise<readonly TenantLink[]>;
  /** Migration 1147: member OR portal-account holder of the organization whose current slug is `label`. */
  emailBelongsToTenant(email: string, label: string): Promise<boolean>;
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
    async emailBelongsToTenant(email, label) {
      const result = await db.execute(sql`SELECT email_belongs_to_tenant(${email}, ${label}) AS ok`);
      return (result as unknown as Rows<{ ok: boolean }>).rows?.[0]?.ok === true;
    },
  };
}

/**
 * The recipient gate of the reset / magic-link host rewrite: the address must belong to the organization whose slug is the
 * label of `host` - as a member OR as a portal-account holder (a patient / caregiver has no membership).
 */
export function createUserMayUseTenantHost(
  lookups: Pick<ReturnType<typeof createDbPublicTenantLookups>, "emailBelongsToTenant">,
  baseDomain: string,
): (email: string, host: string) => Promise<boolean> {
  return async (email, host) => {
    const label = classifyTenantHost(host, baseDomain);
    return label.kind === "tenant" && lookups.emailBelongsToTenant(email.toLowerCase(), label.label);
  };
}
