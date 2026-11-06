// apps/backend/src/modules/23-billing-medicare/tenant-clearinghouse/waiting-work.ts — how many claims an organization still has
// QUEUED for its clearinghouse (a 837I attempt appended `queued` that no worker has taken to an outcome yet). A tenant that
// switches clearinghouse (or to `outside`) while claims wait would strand them: the switch is refused until they finish.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";

/** Queued claim attempts of the org, on a transaction already scoped to it (the config service's own: one pooled connection). */
export async function countQueuedClaimsOn(tx: DbClient, organizationId: string): Promise<number> {
  const S = schema.claimSubmission;
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(S)
    .where(
      and(eq(S.organizationId, organizationId), eq(S.kind, "claim_837i"), eq(S.outcome, "queued")),
    );
  return row?.n ?? 0;
}

/** Queued claim attempts of the org, read under its own RLS scope (a pooled connection of its own: never inside another transaction). */
export async function countQueuedClaims(db: DbClient, organizationId: string): Promise<number> {
  return withOrgContext(db, { organizationId, userId: "" }, (tx) =>
    countQueuedClaimsOn(tx as unknown as DbClient, organizationId),
  );
}
