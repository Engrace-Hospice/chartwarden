// apps/backend/src/bootstrap/jobs/idempotency-cleanup.ts — the M1 `idempotency.cleanup` / `purge_expired` job
// (GAP-113, M1 spec §4.8). `createDbIdempotencyStore.load` treats an expired record as ABSENT and "leaves it for
// the §3.10 sweeper" — a sweeper that did not exist, so `idempotency_key` grew without bound (one row per
// distinct Idempotency-Key ever sent). This is that sweeper: hourly, per active org (the table is RLS-forced, so
// the delete runs under each org's context), deleting rows whose `expires_at` has passed.
//
// Reentrant by construction (§4.8.1: "purge is reentrant"): the DELETE is a pure predicate on `expires_at`, a
// replayed tick or a racing replica simply matches fewer rows. Batched, so one org with a large backlog cannot
// hold a long transaction.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import { registerPlatformJob, systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { inArray, lte } from "drizzle-orm";

export const IDEMPOTENCY_CLEANUP_JOB_ID = "platform.idempotency_cleanup";
export const IDEMPOTENCY_CLEANUP_QUEUE = "idempotency.cleanup";
/** Hourly, at minute 20 (offset from the top of the hour where other crons cluster). */
export const IDEMPOTENCY_CLEANUP_SCHEDULE = "20 * * * *";
/** Rows deleted per statement. */
export const IDEMPOTENCY_PURGE_BATCH = 1000;
/** Upper bound of batches per org per tick, so a tick always terminates; the next tick continues. */
export const IDEMPOTENCY_PURGE_MAX_BATCHES = 50;

export interface IdempotencyCleanupDeps {
  readonly db: DbClient;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly now?: () => Date;
}

/** Allow the purge to enter platform context for the active-org fan-out. */
export function wireIdempotencyCleanupTenancy(): void {
  registerPlatformJob(IDEMPOTENCY_CLEANUP_JOB_ID);
}

async function purgeOrg(
  deps: IdempotencyCleanupDeps,
  organizationId: string,
  now: Date,
): Promise<number> {
  const T = schema.idempotencyKeys;
  let total = 0;
  for (let batch = 0; batch < IDEMPOTENCY_PURGE_MAX_BATCHES; batch += 1) {
    const deleted = await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
      const t = tx as unknown as DbClient;
      const expired = (await t
        .select({ id: T.id })
        .from(T)
        .where(lte(T.expiresAt, now))
        .limit(IDEMPOTENCY_PURGE_BATCH)) as Array<{ id: string }>;
      if (expired.length === 0) return 0;
      await t.delete(T).where(
        inArray(
          T.id,
          expired.map((r) => r.id),
        ),
      );
      return expired.length;
    });
    total += deleted;
    if (deleted < IDEMPOTENCY_PURGE_BATCH) break;
  }
  return total;
}

/** One purge pass over every active org; a failing org does not stop the others, the pass then rejects. */
export async function runIdempotencyCleanup(deps: IdempotencyCleanupDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  let total = 0;
  const failures: string[] = [];
  for (const { organizationId } of orgs) {
    try {
      total += await purgeOrg(deps, organizationId, now);
    } catch (err) {
      failures.push(`${organizationId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `idempotency.cleanup failed for ${failures.length} org(s): ${failures.join("; ")}`,
    );
  }
  return total;
}

export function registerIdempotencyCleanupWorker(
  connection: ConnectionOptions,
  deps: IdempotencyCleanupDeps,
): Worker {
  return new Worker(IDEMPOTENCY_CLEANUP_QUEUE, async () => runIdempotencyCleanup(deps), {
    connection,
    concurrency: 1,
  });
}

export async function scheduleIdempotencyCleanup(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(IDEMPOTENCY_CLEANUP_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: IDEMPOTENCY_CLEANUP_SCHEDULE },
      attempts: 3,
      backoff: { type: "fixed", delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
