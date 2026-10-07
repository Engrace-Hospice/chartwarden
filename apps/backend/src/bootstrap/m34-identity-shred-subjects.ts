import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { and, eq, ne } from "drizzle-orm";

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
