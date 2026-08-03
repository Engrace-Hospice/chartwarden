// apps/backend/src/modules/02-identity — M2's implementation of the `OrganizationReader` seam
// (contract in @wardenx/types) that M35's platform-ops admin lists consume at M35A-T03 to label
// cross-tenant rows with an org display NAME instead of a raw UUID.
//
// M2 owns the `organization` table, so it is the natural producer: M35 reaches it through the published
// seam (no M35→M2-internal import; resolved via the M1 seam registry). The `organization` table is the
// tenancy ROOT (NON_ORG_SCOPED), so a by-id lookup spans tenants with the plain `db` handle and needs no
// `app.org_id` scope — exactly what a cross-tenant admin list requires. Read-only; PHI-free (name/slug only).
import { schema } from "@wardenx/db";
import type { DbClient } from "@wardenx/db";
import type { OrganizationReader, OrganizationSummary } from "@wardenx/types";
import { inArray } from "drizzle-orm";

/**
 * Build M2's real `OrganizationReader` over the org-spine table. Registered into the M1 seam registry by
 * `registerIdentitySeams` when a DB client is present; the registry's graceful deny-stub (resolves no names)
 * stands until then. Batch by design — one `WHERE id = ANY($ids)` per page, no N+1; ids with no matching
 * org are simply absent from the result (the caller falls back to the raw id).
 */
export function createOrganizationReader(db: DbClient): OrganizationReader {
  return {
    async readByIds(organizationIds: readonly string[]): Promise<readonly OrganizationSummary[]> {
      const ids = [...new Set(organizationIds)];
      if (ids.length === 0) return [];
      const rows = await db
        .select({
          organizationId: schema.organizations.id,
          displayName: schema.organizations.displayName,
          legalName: schema.organizations.legalName,
          slug: schema.organizations.slug,
        })
        .from(schema.organizations)
        .where(inArray(schema.organizations.id, ids));
      return rows;
    },
  };
}
