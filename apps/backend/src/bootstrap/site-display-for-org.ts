// apps/backend/src/bootstrap/site-display-for-org.ts — the org-explicit, BATCHED minimum-necessary SITE display
// read other modules' rendered documents need (M14's IDG minutes / packet PDF header: the organization's and the
// meeting location's display NAMES).
//
// It lives in M1's directory (bootstrap/ is M1's code path) because `organization` / `location` /
// `provider_entity` are M1's tables. Consumers get it injected as a locally-declared PORT at the composition
// root (apps/backend/src/index.ts) and import no M1 code or schema — the `membershipDisplayForOrg` (M2) /
// `patientDisplayLabelsForOrg` (M5) shape.
//
// MINIMUM NECESSARY: NAMES ONLY. The organization's `display_name` (the trade/brand name staff recognise;
// falls back to `legal_name` when blank) and each location's `name`. No address, phone, NPI/CCN, tax id,
// timezone. ONE `withOrgContext` transaction and at most TWO queries for the whole call (never N+1). RLS
// (`app.org_id`) is the wall; the explicit `organization.id` / `provider_entity.organization_id` predicates are
// the belt behind it, so an unknown / cross-tenant location id is simply ABSENT from the result.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray } from "drizzle-orm";

const ORG = schema.organizations;
const LOC = schema.locations;
const PROVIDER = schema.providerEntities;

/** A read with no acting human (the `SEAM_SYSTEM_USER_ID` convention — the M4 audit trigger maps "" to NULL). */
const SITE_DISPLAY_SYSTEM_USER_ID = "";

/** A location id list this long is a caller bug (a meeting has ONE location; a report a handful). */
export const SITE_DISPLAY_MAX_LOCATION_IDS = 100;

export interface SiteDisplay {
  /** The organization's display name (legal name when no display name is on file), or null when unresolved. */
  readonly organizationName: string | null;
  /** Location id → display name, for the ids that resolved in this org (others are ABSENT). */
  readonly locationNames: ReadonlyMap<string, string>;
}

const clean = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t.length > 0 ? t : null;
};

/** Pure projection (unit-testable without a DB): display name, else legal name, else null. */
export function toOrganizationDisplayName(row: {
  readonly displayName: string | null;
  readonly legalName: string | null;
}): string | null {
  return clean(row.displayName) ?? clean(row.legalName);
}

export async function siteDisplayForOrg(
  db: DbClient,
  organizationId: string,
  locationIds: readonly string[],
): Promise<SiteDisplay> {
  const ids = [...new Set(locationIds)];
  if (ids.length > SITE_DISPLAY_MAX_LOCATION_IDS) {
    throw new Error(
      `siteDisplayForOrg: ${ids.length} location ids exceeds the ${SITE_DISPLAY_MAX_LOCATION_IDS} cap`,
    );
  }
  return withOrgContext(
    db,
    { organizationId, userId: SITE_DISPLAY_SYSTEM_USER_ID },
    async (txRaw) => {
      const tx = txRaw as unknown as DbClient;
      const [org] = await tx
        .select({ displayName: ORG.displayName, legalName: ORG.legalName })
        .from(ORG)
        .where(eq(ORG.id, organizationId))
        .limit(1);
      const locationNames = new Map<string, string>();
      if (ids.length > 0) {
        const rows = await tx
          .select({ id: LOC.id, name: LOC.name })
          .from(LOC)
          .innerJoin(PROVIDER, eq(PROVIDER.id, LOC.providerEntityId))
          .where(and(eq(PROVIDER.organizationId, organizationId), inArray(LOC.id, ids)));
        for (const r of rows) {
          const name = clean(r.name);
          if (name !== null) locationNames.set(r.id, name);
        }
      }
      return {
        organizationName: org ? toOrganizationDisplayName(org) : null,
        locationNames,
      };
    },
  );
}
