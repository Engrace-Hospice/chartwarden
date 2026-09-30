// apps/backend/src/modules/03-authorization/membership-role-keys-for-org.ts — the org-explicit, BATCHED
// minimum-necessary "which role keys does each of these memberships hold?" read other modules need when they must
// validate a claim ABOUT a membership rather than about the caller (M14's attendance trust: a coordinator recording
// someone else's IDG attendance must have the discipline checked against that person's real roles).
//
// It lives in M3's directory because `membership_role` / `role` are authorization's rows; the consumer gets it injected
// as a locally-declared PORT at the composition root (apps/backend/src/index.ts) and imports no authorization code or
// schema — the `membershipDisplayForOrg` (M2) / `idgRecertWindowsForOrg` (M6) shape. The result is the SAME authority
// `request.context.roles` and M17's `resolveDisciplinesTx` derive from: ENABLED roles on UNEXPIRED assignments.
//
// MINIMUM NECESSARY: role KEY strings only (no ids, permissions, scopes, names). A membership that exists in the
// organization but holds no live role maps to an EMPTY array; an unknown / cross-tenant / revoked membership is ABSENT,
// so a caller can tell "no such staff member" from "staff member with no discipline". RLS (`app.org_id`) is the wall;
// the explicit `organization_id` predicate is the belt behind it. ONE query for the whole id set, never N+1.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";

const MB = schema.memberships;
const MR = schema.membershipRoles;
const RO = schema.roles;

/** A read with no acting human (the `SEAM_SYSTEM_USER_ID` convention — the M4 audit trigger maps "" to NULL). */
const SYSTEM_USER_ID = "";

/** A membership id list this long is a caller bug (a meeting has dozens of people, not thousands). */
export const MEMBERSHIP_ROLE_KEYS_MAX_IDS = 500;

/**
 * Role keys held by each of `membershipIds` in `organizationId`, in ONE query. Unknown / cross-tenant / revoked
 * memberships are omitted from the map; a live membership with no live role maps to `[]`. Empty input: no query.
 */
export async function membershipRoleKeysForOrg(
  db: DbClient,
  organizationId: string,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const ids = [...new Set(membershipIds)];
  if (ids.length === 0) return new Map();
  if (ids.length > MEMBERSHIP_ROLE_KEYS_MAX_IDS) {
    throw new Error(
      `membershipRoleKeysForOrg: ${ids.length} ids exceeds the ${MEMBERSHIP_ROLE_KEYS_MAX_IDS} cap`,
    );
  }
  const now = new Date();
  const rows = await withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, (tx) =>
    tx
      .select({ membershipId: MB.id, roleKey: RO.key })
      .from(MB)
      .leftJoin(
        MR,
        and(
          eq(MR.membershipId, MB.id),
          eq(MR.organizationId, organizationId),
          or(isNull(MR.expiresAt), gt(MR.expiresAt, now)),
        ),
      )
      .leftJoin(RO, and(eq(RO.id, MR.roleId), eq(RO.enabled, true)))
      .where(
        and(eq(MB.organizationId, organizationId), inArray(MB.id, ids), ne(MB.status, "revoked")),
      ),
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = out.get(r.membershipId) ?? new Set<string>();
    if (r.roleKey !== null) set.add(r.roleKey);
    out.set(r.membershipId, set);
  }
  return new Map([...out].map(([k, v]) => [k, [...v].sort()]));
}
