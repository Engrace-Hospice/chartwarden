// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/waiting-work.ts — how many claims an organization still has
// QUEUED for its clearinghouse (a 837I attempt appended `queued` that no worker has taken to an outcome yet). A tenant that
// switches clearinghouse (or to `outside`) while claims wait would strand them: the switch is refused until they finish.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";

/** Queued claim attempts of the org, read under its own RLS scope. */
export async function countQueuedClaims(db: DbClient, organizationId: string): Promise<number> {
  const S = schema.claimSubmission;
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const [row] = await (tx as unknown as DbClient)
      .select({ n: sql<number>`count(*)::int` })
      .from(S)
      .where(
        and(
          eq(S.organizationId, organizationId),
          eq(S.kind, "claim_837i"),
          eq(S.outcome, "queued"),
        ),
      );
    return row?.n ?? 0;
  });
}
