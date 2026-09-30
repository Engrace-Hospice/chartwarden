import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { sql } from "drizzle-orm";

/**
 * F-204 (#248) — how many OTHER active users in an organization can co-sign a lab-transmission recovery. M3 answers which
 * memberships hold the permissions (`MembershipsHoldingPermissionReader`, its own tables); this Foundation half reads
 * only `membership`: distinct ACTIVE users among those memberships, excluding the requester. A two-person control with
 * no second person can only lapse, so M11's service refuses to file the request when this is 0. RLS-scoped by the
 * caller's org context.
 */
export function buildM11CosignerCounter(
  db: DbClient,
  holders: (organizationId: string, permissionKeys: readonly string[]) => Promise<ReadonlySet<string>>,
  permissionKeys: readonly string[],
) {
  return async (organizationId: string, excludeUserId: string): Promise<number> => {
    const membershipIds = [...(await holders(organizationId, permissionKeys))];
    if (membershipIds.length === 0) return 0;
    return withOrgContext(db, { organizationId, userId: excludeUserId }, async (tx) => {
      const res = await tx.execute(sql`
        SELECT count(DISTINCT m.user_id)::int AS n
          FROM membership m
         WHERE m.organization_id = ${organizationId}
           AND m.status = 'active'
           AND m.user_id <> ${excludeUserId}::uuid
           AND m.id IN (${sql.join(
             membershipIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )})`);
      const row = (res as unknown as { rows?: Array<{ n?: number }> }).rows?.[0];
      return Number(row?.n ?? 0);
    });
  };
}
