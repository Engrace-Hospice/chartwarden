// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/onboarding-members.ts — who a tenant's active staff are, for the
// platform operator who assigns the tenant's compliance officer.
//
// MINIMUM NECESSARY: a membership id, a display name, an email and the role keys it holds. No user id, no credential state, no
// login history. Only ACTIVE memberships (a suspended or revoked member can never be the officer). Read on the TENANT pool inside
// `withOrgContext` for the target org, like every other onboarding-data read: RLS is the wall, the explicit organization predicate
// the belt. The role condition is the one the wizard judges an officer by (an enabled role whose grant has not expired).
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";

const MB = schema.memberships;
const U = schema.users;
const MR = schema.membershipRoles;
const R = schema.roles;

/** A tenant this large is a data problem, not a picker: the read is capped rather than unbounded. */
export const MEMBER_LIST_CAP = 500;

export interface TenantMemberView {
  readonly membershipId: string;
  readonly displayName: string | null;
  readonly email: string | null;
  readonly roleKeys: readonly string[];
}

/** Pure projection (unit-testable without a database). */
export function toMemberViews(
  members: ReadonlyArray<{
    readonly membershipId: string;
    readonly name: string | null;
    readonly email: string | null;
  }>,
  roles: ReadonlyArray<{ readonly membershipId: string; readonly key: string }>,
): TenantMemberView[] {
  const keysByMember = new Map<string, string[]>();
  for (const r of roles)
    keysByMember.set(r.membershipId, [...(keysByMember.get(r.membershipId) ?? []), r.key]);
  const views = members.map((m) => {
    const name = m.name?.trim() ?? "";
    return {
      membershipId: m.membershipId,
      displayName: name.length > 0 ? name : null,
      email: m.email,
      roleKeys: [...new Set(keysByMember.get(m.membershipId) ?? [])].sort(),
    };
  });
  // Named members first (by name), then the unnamed (by email): a picker reads top to bottom.
  return views.sort((a, b) => {
    if ((a.displayName === null) !== (b.displayName === null))
      return a.displayName === null ? 1 : -1;
    return (a.displayName ?? a.email ?? "").localeCompare(b.displayName ?? b.email ?? "");
  });
}

export async function listActiveMembers(
  db: DbClient,
  organizationId: string,
  operatorUserId: string,
): Promise<TenantMemberView[]> {
  return withOrgContext<DbClient, TenantMemberView[]>(
    db,
    { organizationId, userId: operatorUserId },
    async (tx) => {
      const members = await tx
        .select({ membershipId: MB.id, name: U.name, email: U.email })
        .from(MB)
        .innerJoin(U, eq(U.id, MB.userId))
        .where(and(eq(MB.organizationId, organizationId), eq(MB.status, "active")))
        .limit(MEMBER_LIST_CAP);
      if (members.length === 0) return [];
      const roles = await tx
        .select({ membershipId: MR.membershipId, key: R.key })
        .from(MR)
        .innerJoin(R, eq(MR.roleId, R.id))
        .where(
          and(
            eq(MR.organizationId, organizationId),
            eq(R.enabled, true),
            or(isNull(MR.expiresAt), gt(MR.expiresAt, sql`now()`)),
          ),
        );
      return toMemberViews(members, roles);
    },
  );
}
