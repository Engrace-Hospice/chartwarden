// apps/backend/src/modules/28-fhir/jobs/session-sweeper.ts — the `fhir.client-session-sweeper` cron (GAP-084,
// §4.8, §8.4). `fhir_client_session` is `operational` retention: kept 90 days past expiry for incident review,
// then routinely purged. Nothing purged it, so the partitioned ledger grew without bound.
//
// Spec §4.8 says "past `expires_at`"; §8.4 says "90 days hot, then routine purge". The retention class wins
// (the conservative reading: keep the evidence longer, never shorter), so rows are deleted once
// `expires_at < now - 90 days`. An expired token is already refused at the bearer check regardless of the row.
// Bounded per org per tick; idempotent (a deleted row is simply absent); one org's failure does not stop the rest.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, asc, eq, inArray, lt } from "drizzle-orm";

import type { ActiveOrgListPort } from "./ports";
import { CLIENT_SESSION_RETENTION_DAYS, SWEEP_BATCH_LIMIT } from "./queues";

const SESSION = schema.fhirClientSession;
const SYSTEM_USER_ID = "";
const MS_PER_DAY = 86_400_000;

export interface SessionSweeperDeps {
  readonly db: DbClient;
  readonly activeOrgs: ActiveOrgListPort;
  readonly now?: () => Date;
  readonly log?: { error(obj: unknown, msg?: string): void };
}

async function sweepOrg(db: DbClient, organizationId: string, cutoff: Date): Promise<number> {
  return withOrgContext(db, { organizationId, userId: SYSTEM_USER_ID }, async (tx) => {
    const t = tx as unknown as DbClient;
    const stale = await t
      .select({ jti: SESSION.jti })
      .from(SESSION)
      .where(and(eq(SESSION.organizationId, organizationId), lt(SESSION.expiresAt, cutoff)))
      .orderBy(asc(SESSION.expiresAt))
      .limit(SWEEP_BATCH_LIMIT);
    if (stale.length === 0) return 0;
    const deleted = await t
      .delete(SESSION)
      .where(
        and(
          eq(SESSION.organizationId, organizationId),
          inArray(
            SESSION.jti,
            stale.map((r) => r.jti),
          ),
        ),
      )
      .returning({ jti: SESSION.jti });
    return deleted.length;
  });
}

/** One sweeper tick across every active org. Returns the number of session rows deleted. */
export async function runClientSessionSweeper(deps: SessionSweeperDeps): Promise<number> {
  const at = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(at.getTime() - CLIENT_SESSION_RETENTION_DAYS * MS_PER_DAY);
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: unknown[] = [];
  let deleted = 0;
  for (const { organizationId } of orgs) {
    try {
      deleted += await sweepOrg(deps.db, organizationId, cutoff);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    deps.log?.error({ failures: failures.length }, "m28 client-session sweeper: some orgs failed");
    throw new AggregateError(
      failures,
      `fhir.client-session-sweeper: ${failures.length} failure(s)`,
    );
  }
  return deleted;
}
