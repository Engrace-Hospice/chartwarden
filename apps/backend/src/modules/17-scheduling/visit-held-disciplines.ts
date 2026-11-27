// apps/backend/src/modules/17-scheduling/visit-held-disciplines.ts — the scheduling disciplines a membership
// holds right now (its live role grants that name a discipline). One definition shared by the write gate
// (scheduling-route-service-db.ts) and the CW-PI-04 pairing reconciliation, so they cannot drift.
import { type DbClient, schema } from "@chartwarden/db";
import { type SchedulingDiscipline, VISIT_PURPOSE_DISCIPLINES } from "@chartwarden/scheduling";
import { and, eq, gt, isNull, or } from "drizzle-orm";

/** Every role key that is a scheduling discipline (rn, lpn, chha, msw, chaplain, volunteer, md, np). */
export const ALL_SCHEDULING_DISCIPLINES = new Set<string>(
  Object.values(VISIT_PURPOSE_DISCIPLINES).flat(),
);

/** Disciplines `membershipId` holds as of now (unexpired role grants), sorted, no duplicates. */
export async function heldSchedulingDisciplines(
  tx: DbClient,
  orgId: string,
  membershipId: string,
): Promise<SchedulingDiscipline[]> {
  const roleRows = await tx
    .select({ key: schema.roles.key })
    .from(schema.membershipRoles)
    .innerJoin(schema.roles, eq(schema.membershipRoles.roleId, schema.roles.id))
    .where(
      and(
        eq(schema.membershipRoles.organizationId, orgId),
        eq(schema.membershipRoles.membershipId, membershipId),
        or(
          isNull(schema.membershipRoles.expiresAt),
          gt(schema.membershipRoles.expiresAt, new Date()),
        ),
      ),
    );
  return [
    ...new Set(
      roleRows
        .map((r) => r.key)
        .filter((k): k is SchedulingDiscipline => ALL_SCHEDULING_DISCIPLINES.has(k)),
    ),
  ].sort();
}
