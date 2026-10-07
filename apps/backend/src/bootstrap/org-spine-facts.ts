// apps/backend/src/bootstrap/org-spine-facts.ts - GAP-155 / GAP-163.
//
// Org-explicit reads over M1/M2-owned spine tables (`provider_entity`, `location`, `membership`) for two background
// jobs whose modules may not reference those tables directly (`arch:tables`): M34's onboarding context
// (provider entities + CCNs, location count) and M30's CAP-overdue owner resolution (membership -> user id). The
// composition root injects these as ports; each call opens its own `withOrgContext` (a cron tick is not a request).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, inArray, sql } from "drizzle-orm";

const SYSTEM_USER_ID = "";

export interface OrgSeedFacts {
  readonly providerEntities: readonly { readonly providerEntityId: string; readonly ccn: string }[];
  readonly locationCount: number;
}

/** The tenant org's provider entities (with CCN) and its location count - the onboarding `org_seeded` facts. */
export function buildOrgSeedFactsReader(db: DbClient): (orgId: string) => Promise<OrgSeedFacts> {
  return (orgId) =>
    withOrgContext(db, { organizationId: orgId, userId: SYSTEM_USER_ID }, async (tx) => {
      const providerEntities = await tx
        .select({
          providerEntityId: schema.providerEntities.id,
          ccn: schema.providerEntities.ccn,
        })
        .from(schema.providerEntities)
        .where(eq(schema.providerEntities.organizationId, orgId));
      const [counted] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.locations)
        .innerJoin(
          schema.providerEntities,
          eq(schema.providerEntities.id, schema.locations.providerEntityId),
        )
        .where(eq(schema.providerEntities.organizationId, orgId));
      return { providerEntities, locationCount: counted?.n ?? 0 };
    });
}

/** Count of active `org_admin` memberships in the org - the onboarding `first_admin_invited` fact. */
export function buildOrgAdminCountReader(db: DbClient): (orgId: string) => Promise<number> {
  return (orgId) =>
    withOrgContext(db, { organizationId: orgId, userId: SYSTEM_USER_ID }, async (tx) => {
      const [counted] = await tx
        .select({ n: sql<number>`count(distinct ${schema.memberships.id})::int` })
        .from(schema.memberships)
        .innerJoin(
          schema.membershipRoles,
          eq(schema.membershipRoles.membershipId, schema.memberships.id),
        )
        .innerJoin(schema.roles, eq(schema.roles.id, schema.membershipRoles.roleId))
        .where(
          and(
            eq(schema.memberships.organizationId, orgId),
            eq(schema.roles.key, "org_admin"),
            eq(schema.memberships.status, "active"),
          ),
        );
      return counted?.n ?? 0;
    });
}

/** membership id -> user id for the given memberships (absent ids simply do not appear in the map). */
export function buildMembershipUserResolver(
  db: DbClient,
): (orgId: string, membershipIds: readonly string[]) => Promise<ReadonlyMap<string, string>> {
  return (orgId, membershipIds) =>
    membershipIds.length === 0
      ? Promise.resolve(new Map())
      : withOrgContext(db, { organizationId: orgId, userId: SYSTEM_USER_ID }, async (tx) => {
          const rows = await tx
            .select({ id: schema.memberships.id, userId: schema.memberships.userId })
            .from(schema.memberships)
            .where(
              and(
                eq(schema.memberships.organizationId, orgId),
                inArray(schema.memberships.id, [...membershipIds]),
              ),
            );
          return new Map(rows.map((r) => [r.id, r.userId]));
        });
}
