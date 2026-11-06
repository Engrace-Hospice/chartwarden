// apps/backend/src/bootstrap/tenant-slug-registry.ts — M1 owns `organization.slug` and `organization_slug_alias` (migration 1144).
// The one question other modules ask of them is "is this host label held, now or ever?": a slug is never reused, so a retired
// one (an alias) is as unavailable as a live one (ADR-0049 D3). The caller supplies the transaction, so M34's platform console
// reads under its audited `withPlatformContext`; the platform login holds SELECT on both tables (provision-runtime-roles.ts).
import { type DbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";

export async function isTenantSlugTaken(tx: DbClient, slug: string): Promise<boolean> {
  const [live] = await tx
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug))
    .limit(1);
  if (live) return true;
  const [retired] = await tx
    .select({ id: schema.organizationSlugAliases.id })
    .from(schema.organizationSlugAliases)
    .where(eq(schema.organizationSlugAliases.alias, slug))
    .limit(1);
  return retired !== undefined;
}
