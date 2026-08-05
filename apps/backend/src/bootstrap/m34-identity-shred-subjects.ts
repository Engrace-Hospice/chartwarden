import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { and, eq, ne, sql } from "drizzle-orm";

/** Resolve the active co-signer identity without exposing the M1 membership table to M34. */
export async function m34ActiveMembershipUserId(
  tx: DbClient,
  membershipId: string,
): Promise<string | null> {
  const [membership] = await tx
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.id, membershipId), ne(schema.memberships.status, "revoked")))
    .limit(1);
  return membership?.userId ?? null;
}

/** Shared identities survive a tenant shred; only users exclusive to this tenant are eraser subjects. */
export async function m34SoleTenantUserIds(
  tx: DbClient,
  orgId: string,
): Promise<readonly string[]> {
  const rows = await tx.execute<{ user_id: string }>(sql`
    SELECT DISTINCT m.user_id
      FROM membership m
     WHERE m.organization_id = ${orgId}
       AND m.status <> 'revoked'
       AND NOT EXISTS (
         SELECT 1 FROM membership other
          WHERE other.user_id = m.user_id
            AND other.organization_id <> ${orgId}
            AND other.status <> 'revoked'
       )
     ORDER BY m.user_id
  `);
  return rows.rows.map((row) => row.user_id);
}
