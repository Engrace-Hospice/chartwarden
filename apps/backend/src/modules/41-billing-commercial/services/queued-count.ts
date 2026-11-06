// apps/backend/src/modules/41-billing-commercial/services/queued-count.ts — how many commercial submissions an organization still
// has QUEUED for its clearinghouse. The tenant clearinghouse service reads it (through the composition root) so a switch of
// clearinghouse is refused while submissions wait: they would otherwise be stranded on a vendor the org no longer uses.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";

/** Queued submissions of the org, on a transaction already scoped to it (the config service's own: one pooled connection). */
export async function countQueuedCommercialSubmissionsOn(
  tx: DbClient,
  organizationId: string,
): Promise<number> {
  const S = schema.commercialSubmissions;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(S)
    .where(and(eq(S.organizationId, organizationId), eq(S.status, "queued")));
  return row?.n ?? 0;
}

/** Queued submissions of the org, read under its own RLS scope (a pooled connection of its own: never inside another transaction). */
export async function countQueuedCommercialSubmissions(
  db: DbClient,
  organizationId: string,
): Promise<number> {
  return withOrgContext(db, { organizationId, userId: "" }, (tx) =>
    countQueuedCommercialSubmissionsOn(tx as unknown as DbClient, organizationId),
  );
}
