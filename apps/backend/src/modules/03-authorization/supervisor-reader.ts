// apps/backend/src/modules/03-authorization/supervisor-reader.ts — the Drizzle reader backing M3's
// `SupervisorReader` seam (membership location scope + derived supervision), consumed by M33/M36.
//
// OWNERSHIP: M3 owns the role grants supervision is derived from; the membership row it also reads is M1's
// (the same read `membership-role-keys-for-org.ts` already makes).
//
// NO EXPLICIT SUPERVISOR RELATION EXISTS in the data model (no reporting-line / supervisor column, no team
// table), and none is invented here. Supervision is DERIVED from facts that do exist:
//   * a membership's location scope is its `default_location_ids` (ACTIVE memberships only; the grant has no
//     expiry of its own, so "unexpired" is the membership status);
//   * a membership is a SUPERVISOR when it is active AND holds an unexpired grant of a role whose key is in
//     {@link SUPERVISORY_ROLE_KEYS} (an enabled role; a tenant-owned row squatting a reserved platform key
//     confers nothing — the `roleConfersKey` rule every other role read applies);
//   * it supervises every OTHER active membership that shares at least one of its locations.
// The grant's `scope` jsonb is NOT consulted (its shape is not standardised), so a grant narrowed below the
// membership's locations is treated as covering all of them. This is a documented over-approximation.
// Every method fails closed: unknown / cross-tenant / non-active memberships resolve to `[]` / `false`.
import { roleConfersKey } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { SupervisorReader } from "@chartwarden/types";
import { and, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";

const MB = schema.memberships;
const MR = schema.membershipRoles;
const RO = schema.roles;

/** A read with no acting human (the `SEAM_SYSTEM_USER_ID` convention — the audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

/** Role keys that make an active membership a location supervisor. */
export const SUPERVISORY_ROLE_KEYS: readonly string[] = [
  "clinical_supervisor",
  "director_of_nursing",
];

type Tx = DbClient;

function stringIds(raw: unknown): readonly string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

async function locationIdsTx(tx: Tx, organizationId: string, membershipId: string) {
  const rows = (await tx
    .select({ locationIds: MB.defaultLocationIds })
    .from(MB)
    .where(
      and(eq(MB.organizationId, organizationId), eq(MB.id, membershipId), eq(MB.status, "active")),
    )
    .limit(1)) as Array<{ locationIds: unknown }>;
  return stringIds(rows[0]?.locationIds);
}

async function holdsSupervisoryRoleTx(tx: Tx, organizationId: string, membershipId: string) {
  const rows = (await tx
    .select({
      roleKey: RO.key,
      roleOrganizationId: RO.organizationId,
      roleCategory: RO.category,
    })
    .from(MR)
    .innerJoin(RO, eq(RO.id, MR.roleId))
    .where(
      and(
        eq(MR.organizationId, organizationId),
        eq(MR.membershipId, membershipId),
        or(isNull(MR.expiresAt), gt(MR.expiresAt, new Date())),
        eq(RO.enabled, true),
        inArray(RO.key, [...SUPERVISORY_ROLE_KEYS]),
      ),
    )) as Array<{ roleKey: string; roleOrganizationId: string | null; roleCategory: string }>;
  return rows.some((r) =>
    roleConfersKey({
      organizationId: r.roleOrganizationId,
      key: r.roleKey,
      category: r.roleCategory,
    }),
  );
}

export function createSupervisorReader(db: DbClient): SupervisorReader {
  const run = <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, (tx) => fn(tx as unknown as Tx));
  return {
    membershipLocationIds: ({ organizationId, membershipId }) =>
      run(organizationId, (tx) => locationIdsTx(tx, organizationId, membershipId)),

    isSupervisorForLocation: ({ organizationId, membershipId, locationId }) =>
      run(organizationId, async (tx) => {
        const locations = await locationIdsTx(tx, organizationId, membershipId);
        if (!locations.includes(locationId)) return false;
        return holdsSupervisoryRoleTx(tx, organizationId, membershipId);
      }),

    resolveSupervisedMembershipIds: ({ organizationId, membershipId }) =>
      run(organizationId, async (tx) => {
        const locations = await locationIdsTx(tx, organizationId, membershipId);
        if (locations.length === 0) return [];
        if (!(await holdsSupervisoryRoleTx(tx, organizationId, membershipId))) return [];
        const rows = (await tx
          .select({ id: MB.id })
          .from(MB)
          .where(
            and(
              eq(MB.organizationId, organizationId),
              eq(MB.status, "active"),
              ne(MB.id, membershipId),
              or(
                ...locations.map(
                  (l) => sql`${MB.defaultLocationIds} @> ${JSON.stringify([l])}::jsonb`,
                ),
              ),
            ),
          )) as Array<{ id: string }>;
        return [...new Set(rows.map((r) => r.id).filter((id) => id !== membershipId))].sort();
      }),
  };
}
