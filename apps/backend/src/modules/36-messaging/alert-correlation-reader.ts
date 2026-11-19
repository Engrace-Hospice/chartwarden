// apps/backend/src/modules/36-messaging/alert-correlation-reader.ts — "which of these alerts already exist?", for a producer that
// would otherwise re-emit them every tick (ADR-0113 D5: the visit-note closure sweep).
//
// `AlertEmitter.emit` is idempotent on `(organization, correlation id)`, but it resolves the rule and the recipients BEFORE it
// notices the repeat, so a sweep that re-emitted every still-due alert each tick would pay that resolution for nothing. M36 owns the
// `alert` table, so M36 answers the question, and the composition root hands the answer to the producer as a plain function
// (the producer imports nothing from here). The read is one RLS-scoped transaction as the app role: `alert_org_isolation` hides
// every other tenant's rows, and the predicate names the organization too.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray } from "drizzle-orm";

const AL = schema.alerts;

/**
 * One `IN (...)` list stays well under Postgres' 65,535 bind-parameter ceiling and keeps each statement small; a sweep over a very
 * large backlog just issues a few statements in the one transaction.
 */
export const ALERT_CORRELATION_CHUNK_SIZE = 1_000;

/** The correlation ids among `correlationIds` that already have an alert in the organization. */
export type AlertCorrelationReader = (
  organizationId: string,
  correlationIds: readonly string[],
) => Promise<ReadonlySet<string>>;

function chunksOf<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );
}

export function createDbAlertCorrelationReader(db: DbClient): AlertCorrelationReader {
  return async (organizationId, correlationIds) => {
    if (correlationIds.length === 0) return new Set<string>();
    return withOrgContext(db, systemOrgContext(organizationId), async (tx) => {
      const found = new Set<string>();
      for (const chunk of chunksOf([...new Set(correlationIds)], ALERT_CORRELATION_CHUNK_SIZE)) {
        const rows = await (tx as unknown as DbClient)
          .select({ correlationId: AL.correlationId })
          .from(AL)
          .where(and(eq(AL.organizationId, organizationId), inArray(AL.correlationId, [...chunk])));
        for (const row of rows) found.add(row.correlationId);
      }
      return found;
    });
  };
}
