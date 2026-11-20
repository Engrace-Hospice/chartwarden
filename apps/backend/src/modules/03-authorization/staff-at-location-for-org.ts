// apps/backend/src/modules/03-authorization/staff-at-location-for-org.ts — the org-explicit, location-scoped
// "which active staff hold one of these roles at this location?" read M15's Aide POC supervisory-visit pickers
// need (an RN cannot call the org-admin member list, so the modal had no staff source).
//
// It lives in M3's directory because `membership_role` / `role` are authorization's rows; the consumer gets it
// injected as a locally-declared PORT at the composition root (apps/backend/src/index.ts) and imports no
// authorization code or schema — the `membershipRoleKeysForOrg` / `membershipDisplayForOrg` shape.
//
// WHO QUALIFIES (every condition, or the member is absent):
//   * the membership is `active` and so is its user (a suspended / deactivated account is never offered);
//   * the member holds a requested role through a LIVE grant: an ENABLED role on an UNEXPIRED assignment,
//     minus a reserved platform key carried by a TENANT-owned row (`roleConfersKey`, GAP-003/GAP-096 — the
//     same rule the actor-enrichment reader applies);
//   * the member's EFFECTIVE location reach includes `locationId`. That is exactly what stamps
//     `request.context.locationIds`: the membership's `default_location_ids`, narrowed by the scope of the
//     member's live grants (`effectiveReach`, GAP-007). An empty reach contains no location (the platform's
//     `location_scope` reads it that way), so a member with no location siting is not offered.
//
// MINIMUM NECESSARY: membership id, the display NAME (`user.name` — never the email, the username or any
// licence) and the qualifying role key. ONE query for the member set (their other live grants ride along so
// the reach is computed over all of them), never N+1. RLS (`app.org_id`) is the wall; the explicit
// `organization_id` predicates are the belt behind it.
import { effectiveReach, roleConfersKey } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";

const MB = schema.memberships;
const MR = schema.membershipRoles;
const RO = schema.roles;
const US = schema.users;

/** A read with no acting human (the `SEAM_SYSTEM_USER_ID` convention — the M4 audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

/** One (member, qualifying role) pair. `displayName` is null when the user has no name on file. */
export interface StaffAtLocationRow {
  readonly membershipId: string;
  readonly displayName: string | null;
  readonly roleKey: string;
}

export interface StaffAtLocationQuery {
  readonly organizationId: string;
  readonly locationId: string;
  readonly roleKeys: readonly string[];
}

const stringIds = (raw: unknown): readonly string[] =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];

/** One live grant of a candidate member, joined to the member's own facts. */
export interface LiveGrantRow {
  readonly membershipId: string;
  readonly defaultProviderEntityId: string | null;
  readonly defaultLocationIds: unknown;
  readonly name: string | null;
  readonly roleKey: string;
  readonly roleOrganizationId: string | null;
  readonly roleCategory: string;
  readonly scope: unknown;
}

/**
 * Pure: fold every live grant of the candidate members into the (member, requested role) pairs whose effective
 * reach includes `locationId`. Unit-testable without a database.
 */
export function reduceToStaff(
  grants: readonly LiveGrantRow[],
  locationId: string,
  roleKeys: readonly string[],
): readonly StaffAtLocationRow[] {
  const byMember = new Map<string, LiveGrantRow[]>();
  for (const g of grants) {
    const conferring = roleConfersKey({
      organizationId: g.roleOrganizationId,
      key: g.roleKey,
      category: g.roleCategory,
    });
    if (!conferring) continue;
    byMember.set(g.membershipId, [...(byMember.get(g.membershipId) ?? []), g]);
  }
  const out: StaffAtLocationRow[] = [];
  for (const [membershipId, live] of byMember) {
    const first = live[0];
    if (!first) continue;
    const { locationIds } = effectiveReach(
      {
        providerEntityIds: first.defaultProviderEntityId ? [first.defaultProviderEntityId] : [],
        locationIds: stringIds(first.defaultLocationIds),
      },
      live.map((g) => ({ scope: g.scope })),
    );
    if (!locationIds.includes(locationId)) continue;
    for (const roleKey of new Set(live.map((g) => g.roleKey))) {
      if (roleKeys.includes(roleKey)) {
        out.push({ membershipId, displayName: first.name, roleKey });
      }
    }
  }
  return out;
}

/**
 * Active staff in `organizationId` holding any of `roleKeys` whose effective reach includes `locationId`, one row
 * per (member, role). Empty `roleKeys` performs no query.
 */
export async function staffAtLocationForOrg(
  db: DbClient,
  query: StaffAtLocationQuery,
): Promise<readonly StaffAtLocationRow[]> {
  const { organizationId, locationId, roleKeys } = query;
  if (roleKeys.length === 0) return [];
  const now = new Date();
  const liveGrant = and(
    eq(MR.organizationId, organizationId),
    or(isNull(MR.expiresAt), gt(MR.expiresAt, now)),
    eq(RO.enabled, true),
  );
  const grants = await withOrgContext(
    db,
    { organizationId, userId: SYSTEM_USER_ID },
    async (tx) => {
      // Active members holding a requested role through a live grant…
      const candidates = await tx
        .selectDistinct({ membershipId: MB.id })
        .from(MB)
        .innerJoin(US, eq(US.id, MB.userId))
        .innerJoin(MR, and(eq(MR.membershipId, MB.id), eq(MR.organizationId, organizationId)))
        .innerJoin(RO, eq(RO.id, MR.roleId))
        .where(
          and(
            eq(MB.organizationId, organizationId),
            eq(MB.status, "active"),
            eq(US.status, "active"),
            liveGrant,
            inArray(RO.key, [...roleKeys]),
          ),
        );
      if (candidates.length === 0) return [];
      // …then ALL of their live grants (the reach is a union over every role, not just the requested ones).
      return tx
        .select({
          membershipId: MB.id,
          defaultProviderEntityId: MB.defaultProviderEntityId,
          defaultLocationIds: MB.defaultLocationIds,
          name: US.name,
          roleKey: RO.key,
          roleOrganizationId: RO.organizationId,
          roleCategory: RO.category,
          scope: MR.scope,
        })
        .from(MB)
        .innerJoin(US, eq(US.id, MB.userId))
        .innerJoin(MR, and(eq(MR.membershipId, MB.id), eq(MR.organizationId, organizationId)))
        .innerJoin(RO, eq(RO.id, MR.roleId))
        .where(
          and(
            eq(MB.organizationId, organizationId),
            inArray(
              MB.id,
              candidates.map((c) => c.membershipId),
            ),
            liveGrant,
          ),
        );
    },
  );
  return reduceToStaff(grants, locationId, roleKeys);
}
