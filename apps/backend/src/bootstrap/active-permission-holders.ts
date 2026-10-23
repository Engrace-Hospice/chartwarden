// apps/backend/src/bootstrap/active-permission-holders.ts - how many people in this organisation can exercise one permission today.
// Published to other modules as a port bound at the composition root (apps/backend/src/index.ts): M36 governance (the single-officer redaction
// fallback, ADR-0055 D9) declares the matching port structurally and reads none of these tables itself.
//
// The same split as `m11-cosigner-counter.ts`: M3 answers which memberships hold the key through an enabled, unexpired role grant
// (`MembershipsHoldingPermissionReader`, its own tables); this Foundation half reads only `membership` and counts DISTINCT ACTIVE users among
// them. Conservative on purpose: a person merely on leave still counts, so the fallback never opens because someone is away. A permission
// reached any other way (a platform grant, an elevation) is not seen; the fallback also demands the tenant flag and a fresh step-up, so an
// undercount can only matter for a tenant that has switched the fallback on. Runs in the caller's tenant transaction (RLS on membership).
import type { DbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";

export type ActivePermissionHolderCounter = (
  tx: DbClient,
  organizationId: string,
  permissionKey: string,
) => Promise<number>;

export function buildActivePermissionHolderCounter(
  holders: (
    organizationId: string,
    permissionKeys: readonly string[],
  ) => Promise<ReadonlySet<string>>,
): ActivePermissionHolderCounter {
  return async (tx, organizationId, permissionKey) => {
    const membershipIds = [...(await holders(organizationId, [permissionKey]))];
    if (membershipIds.length === 0) return 0;
    const result = await tx.execute<{ n: number }>(
      sql`SELECT count(DISTINCT m.user_id)::int AS n
            FROM membership m
           WHERE m.organization_id = ${organizationId}::uuid
             AND m.status = 'active'
             AND m.id IN (${sql.join(
               membershipIds.map((id) => sql`${id}::uuid`),
               sql`, `,
             )})`,
    );
    return Number(result.rows[0]?.n ?? 0);
  };
}
