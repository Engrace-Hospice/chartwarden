// apps/backend/src/modules/05-patient/care-team-staff-db.ts — Drizzle-backed care-team staff lookup.
// One `withOrgContext` transaction (RLS scopes membership / membership_role by app.org_id; `user` is not
// RLS'd, so it is reached only through an in-org membership join). Active memberships only — the same
// set `assign` accepts (see assignments-db.ts ClinicianNotInOrgError). The name filter is a literal
// substring (LIKE wildcards escaped) and matches display name only, so it cannot be used to probe emails.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { CareTeamStaffPort, CareTeamStaffView } from "./care-team-staff";

const MB = schema.memberships;
const U = schema.users;
const MR = schema.membershipRoles;
const R = schema.roles;

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createDbCareTeamStaffPort(db: DbClient): CareTeamStaffPort {
  return {
    async search(organizationId, { q, limit }) {
      return withOrgContext<DbClient, readonly CareTeamStaffView[]>(
        db,
        { organizationId, userId: "" },
        async (tx) => {
          const scope = and(eq(MB.organizationId, organizationId), eq(MB.status, "active"));
          const where = q ? and(scope, sql`${U.name} ILIKE ${`%${escapeLike(q)}%`}`) : scope;
          const members = await tx
            .select({ userId: MB.userId, membershipId: MB.id, displayName: U.name })
            .from(MB)
            .innerJoin(U, eq(U.id, MB.userId))
            .where(where)
            .orderBy(asc(U.name), asc(MB.id))
            .limit(limit);
          if (members.length === 0) return [];
          const roleRows = await tx
            .select({ membershipId: MR.membershipId, name: R.name })
            .from(MR)
            .innerJoin(R, eq(R.id, MR.roleId))
            .where(
              and(
                inArray(
                  MR.membershipId,
                  members.map((m) => m.membershipId),
                ),
                or(isNull(MR.expiresAt), gt(MR.expiresAt, sql`now()`)),
              ),
            )
            .orderBy(asc(R.name));
          return members.map((m) => ({
            userId: m.userId,
            membershipId: m.membershipId,
            displayName: m.displayName,
            roleLabels: roleRows
              .filter((r) => r.membershipId === m.membershipId)
              .map((r) => r.name),
          }));
        },
      );
    },
  };
}
