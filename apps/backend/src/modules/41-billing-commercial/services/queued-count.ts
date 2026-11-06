// apps/backend/src/modules/41-billing-commercial/services/queued-count.ts — how many commercial submissions an organization still
// has QUEUED for its clearinghouse. The tenant clearinghouse service reads it (through the composition root) so a switch of
// clearinghouse is refused while submissions wait: they would otherwise be stranded on a vendor the org no longer uses.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";

/** Queued submissions of the org, read under its own RLS scope. */
export async function countQueuedCommercialSubmissions(
  db: DbClient,
  organizationId: string,
): Promise<number> {
  const S = schema.commercialSubmissions;
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const [row] = await (tx as unknown as DbClient)
      .select({ n: sql<number>`count(*)::int` })
      .from(S)
      .where(and(eq(S.organizationId, organizationId), eq(S.status, "queued")));
    return row?.n ?? 0;
  });
}
