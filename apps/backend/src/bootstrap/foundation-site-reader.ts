// apps/backend/src/bootstrap/foundation-site-reader.ts — M1 Foundation's narrow siting reads over its own
// `provider_entity` + `location` tables (the tenancy spine's Medicare-certified provider and its service
// locations), published so downstream modules stop importing M1's Drizzle schema for them
// (scripts/check-table-ownership.ts — cross-module READS go through the owner's exported reader).
//
// Consumers today: M6 (admission siting — default location for a provider entity, the location↔provider
// consistency check on an admission update) and M10 (the HOPE Admission prefill's provider NPI/CCN).
//
// TRANSACTIONALITY. Every method takes the CALLER's org-context tx (the `PrimaryProviderEntityResolver`
// precedent in ./provider-entity-resolver.ts): the reads run inside the consumer's own `withOrgContext`
// transaction, so RLS scopes them to the same `app.org_id` and they see the same snapshot the consumer's
// write does. No method opens its own transaction or switches tenants.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq, inArray, sql } from "drizzle-orm";

const PROVIDER = schema.providerEntities;
const LOCATION = schema.locations;

export interface FoundationSiteReader {
  /**
   * The default service location for a provider entity: prefer an `active` location, else a `created`
   * one, ties broken by name. Null when the provider entity has no active/created location.
   */
  defaultLocationIdForProviderEntity(
    tx: DbClient,
    providerEntityId: string,
  ): Promise<string | null>;
  /** The provider entity a location belongs to, or null when the location is not visible/unknown. */
  locationProviderEntity(
    tx: DbClient,
    locationId: string,
  ): Promise<{ readonly providerEntityId: string } | null>;
  /** A provider entity's CMS identifiers (NPI + CCN), or null when not found in the org. */
  providerEntityIdentifiers(
    tx: DbClient,
    organizationId: string,
    providerEntityId: string,
  ): Promise<{ readonly npi: string; readonly ccn: string } | null>;
}

export function buildFoundationSiteReader(): FoundationSiteReader {
  return {
    async defaultLocationIdForProviderEntity(tx, providerEntityId) {
      const [location] = await tx
        .select({ id: LOCATION.id })
        .from(LOCATION)
        .where(
          and(
            eq(LOCATION.providerEntityId, providerEntityId),
            inArray(LOCATION.status, ["active", "created"]),
          ),
        )
        .orderBy(sql`CASE WHEN ${LOCATION.status} = 'active' THEN 0 ELSE 1 END`, LOCATION.name)
        .limit(1);
      return location?.id ?? null;
    },

    async locationProviderEntity(tx, locationId) {
      const [location] = await tx
        .select({ providerEntityId: LOCATION.providerEntityId })
        .from(LOCATION)
        .where(eq(LOCATION.id, locationId))
        .limit(1);
      return location ?? null;
    },

    async providerEntityIdentifiers(tx, organizationId, providerEntityId) {
      const [provider] = await tx
        .select({ npi: PROVIDER.npi, ccn: PROVIDER.ccn })
        .from(PROVIDER)
        .where(and(eq(PROVIDER.id, providerEntityId), eq(PROVIDER.organizationId, organizationId)))
        .limit(1);
      return provider ?? null;
    },
  };
}
