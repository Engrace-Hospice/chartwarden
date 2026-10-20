// apps/backend/src/bootstrap/foundation-site-reader.ts — M1 Foundation's narrow siting reads over its own
// `provider_entity` + `location` tables (the tenancy spine's Medicare-certified provider and its service
// locations), published so downstream modules stop importing M1's Drizzle schema for them
// (scripts/check-table-ownership.ts — cross-module READS go through the owner's exported reader).
//
// Consumers today: M6 (admission siting — default location for a provider entity, the location↔provider
// consistency check on an admission update) and M10 (the HOPE Admission prefill's provider NPI/CCN, and
// the iQIES submission header's facility ID + state).
//
// TRANSACTIONALITY. Every method takes the CALLER's org-context tx (the `PrimaryProviderEntityResolver`
// precedent in ./provider-entity-resolver.ts): the reads run inside the consumer's own `withOrgContext`
// transaction, so RLS scopes them to the same `app.org_id` and they see the same snapshot the consumer's
// write does. No method opens its own transaction or switches tenants.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq, inArray, ne, sql } from "drizzle-orm";

const PROVIDER = schema.providerEntities;
const LOCATION = schema.locations;

export interface FoundationSiteReader {
  /**
   * The service location to default an admission to: the provider entity's only `active` location, else
   * its only `created` one. Null when there is none OR more than one candidate — `location` carries no
   * primary flag, so picking by name would silently site the admission at the wrong place and skip the
   * activation-time choice (`resolveActivationLocation` refuses to guess for the same reason).
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
  /**
   * The facts a CMS HOPE submission header needs from the provider entity: its iQIES facility ID
   * (FAC_ID) and the state postal code of its first address that has one (STATE_CD). Null when the
   * provider entity is not found in the org.
   */
  providerEntitySubmissionProfile(
    tx: DbClient,
    organizationId: string,
    providerEntityId: string,
  ): Promise<{ readonly iqiesFacilityId: string | null; readonly stateCode: string | null } | null>;
  /**
   * F-166 (#248) — the location's IANA timezone, for M13's §2.3 D2 scheduled-dose materializer (DST-exact
   * administration-instant resolution). `location.timezone` is NOT NULL when the row exists; null here
   * means the id does not resolve (unknown / deleted), never "no timezone set" — the caller falls back
   * to the platform's own documented default zone for that case (`@wardenx/emar`'s
   * `DEFAULT_ORDER_TIME_ZONE`, the same fallback M10's `m6-admission-workflow.ts` consumer already uses).
   */
  locationTimezone(tx: DbClient, locationId: string): Promise<string | null>;
  /**
   * The distinct IANA timezones of a provider entity's locations (empty when it has none). M25 ends an
   * appeal's last filing day in this zone when the locations agree on one.
   */
  providerEntityTimezones(tx: DbClient, providerEntityId: string): Promise<readonly string[]>;
  /**
   * GAP-057 — which of `providerEntityIds` are `active` in the caller's org. M19's §4.8 coverage-gap
   * watchdog narrows its own policy-bearing entities to the ones that are live (a suspended CCN has no
   * coverage obligation). Ids that do not resolve under the caller's RLS scope are simply absent.
   */
  activeProviderEntityIds(
    tx: DbClient,
    providerEntityIds: readonly string[],
  ): Promise<readonly string[]>;
  /**
   * True when every id in `locationIds` is a non-closed location of a provider entity in `organizationId`
   * (duplicates ignored; an empty list is trivially true). M2's user provisioning validates the default
   * locations it assigns with this instead of reading M1's tables itself.
   */
  allLocationsOpenInOrg(
    tx: DbClient,
    organizationId: string,
    locationIds: readonly string[],
  ): Promise<boolean>;
  /** FY2027 — the provider entity's legal name: the "name of the hospice" the 42 CFR 418.24(c)(2) election
   *  statement addendum prints (M6). Null when the provider entity is not found in the org. */
  providerEntityLegalName(
    tx: DbClient,
    organizationId: string,
    providerEntityId: string,
  ): Promise<string | null>;
}

/** The single candidate id, preferring `active` over `created`; null when there is no unambiguous one. */
export function soleDefaultLocation(
  rows: ReadonlyArray<{ readonly id: string; readonly status: string }>,
): string | null {
  const active = rows.filter((r) => r.status === "active");
  const candidates = active.length > 0 ? active : rows.filter((r) => r.status === "created");
  return candidates.length === 1 ? (candidates[0] as { id: string }).id : null;
}

export function buildFoundationSiteReader(): FoundationSiteReader {
  return {
    async defaultLocationIdForProviderEntity(tx, providerEntityId) {
      const rows = await tx
        .select({ id: LOCATION.id, status: LOCATION.status })
        .from(LOCATION)
        .where(
          and(
            eq(LOCATION.providerEntityId, providerEntityId),
            inArray(LOCATION.status, ["active", "created"]),
          ),
        );
      return soleDefaultLocation(rows);
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
    async providerEntitySubmissionProfile(tx, organizationId, providerEntityId) {
      const [provider] = await tx
        .select({ iqiesFacilityId: PROVIDER.iqiesFacilityId, addresses: PROVIDER.addresses })
        .from(PROVIDER)
        .where(and(eq(PROVIDER.id, providerEntityId), eq(PROVIDER.organizationId, organizationId)))
        .limit(1);
      if (!provider) return null;
      const addresses = Array.isArray(provider.addresses)
        ? (provider.addresses as { state?: unknown }[])
        : [];
      const state = addresses.find((a) => typeof a?.state === "string" && a.state.trim())?.state;
      return {
        iqiesFacilityId: provider.iqiesFacilityId,
        stateCode: typeof state === "string" ? state.trim() : null,
      };
    },

    async activeProviderEntityIds(tx, providerEntityIds) {
      if (providerEntityIds.length === 0) return [];
      const rows = await tx
        .select({ id: PROVIDER.id })
        .from(PROVIDER)
        .where(and(inArray(PROVIDER.id, [...providerEntityIds]), eq(PROVIDER.status, "active")));
      return rows.map((r) => r.id);
    },

    async locationTimezone(tx, locationId) {
      const [location] = await tx
        .select({ timezone: LOCATION.timezone })
        .from(LOCATION)
        .where(eq(LOCATION.id, locationId))
        .limit(1);
      return location?.timezone ?? null;
    },

    async providerEntityTimezones(tx, providerEntityId) {
      const rows = await tx
        .selectDistinct({ timezone: LOCATION.timezone })
        .from(LOCATION)
        .where(eq(LOCATION.providerEntityId, providerEntityId));
      return rows.map((r) => r.timezone);
    },

    async allLocationsOpenInOrg(tx, organizationId, locationIds) {
      const wanted = [...new Set(locationIds)];
      if (wanted.length === 0) return true;
      const rows = await tx
        .select({ id: LOCATION.id })
        .from(LOCATION)
        .innerJoin(PROVIDER, eq(PROVIDER.id, LOCATION.providerEntityId))
        .where(
          and(
            eq(PROVIDER.organizationId, organizationId),
            inArray(LOCATION.id, wanted),
            ne(LOCATION.status, "closed"),
          ),
        );
      return rows.length === wanted.length;
    },

    async providerEntityLegalName(tx, organizationId, providerEntityId) {
      const [provider] = await tx
        .select({ legalName: PROVIDER.legalName })
        .from(PROVIDER)
        .where(and(eq(PROVIDER.id, providerEntityId), eq(PROVIDER.organizationId, organizationId)))
        .limit(1);
      return provider?.legalName ?? null;
    },
  };
}
