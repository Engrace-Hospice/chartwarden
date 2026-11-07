import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, count, eq, min } from "drizzle-orm";

const A = schema.remittanceAdvice;
const L = schema.remittanceLine;

/** M25-owned, organization-scoped aggregate only; no advice, payer, provider, or claim identifiers escape. */
export function createM25FinancialOpsReader(db: DbClient) {
  return {
    async forOrganization(organizationId: string) {
      return withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
        const statuses = await tx.select({ status: A.parseStatus, count: count(), oldest: min(A.receivedAt) })
          .from(A).where(eq(A.organizationId, organizationId)).groupBy(A.parseStatus);
        const [unmatched] = await tx.select({ count: count(), oldest: min(L.receivedAt) }).from(L)
          .where(and(eq(L.organizationId, organizationId), eq(L.matchState, "unmatched")));
        return { statuses: Object.fromEntries(statuses.map((row) => [row.status, row.count])),
          unmatchedLines: unmatched?.count ?? 0,
          oldestReviewAt: [
            ...statuses.filter((row) => ["queued", "failed", "held_duplicate"].includes(row.status)).map((row) => row.oldest),
            unmatched?.oldest ?? null,
          ].filter((value): value is Date => value instanceof Date).reduce<number | null>((oldest, value) =>
            oldest === null ? value.getTime() : Math.min(oldest, value.getTime()), null),
        };
      });
    },
  };
}
