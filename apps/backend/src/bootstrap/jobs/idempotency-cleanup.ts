// apps/backend/src/bootstrap/jobs/idempotency-cleanup.ts — the M1 `idempotency.cleanup` / `purge_expired` job
// (GAP-113, M1 spec §4.8). `createDbIdempotencyStore.load` treats an expired record as ABSENT and "leaves it for
// the §3.10 sweeper" — a sweeper that did not exist, so `idempotency_key` grew without bound (one row per
// distinct Idempotency-Key ever sent). This is that sweeper: hourly, per organization IN EVERY STATUS (the table is
// RLS-forced, so the delete runs under each org's context), deleting rows whose `expires_at` has passed. Every status,
// not only `active`: an org in `created` (the onboarding orgs, where platform operators write with an Idempotency-Key),
// `suspended` or `closed` holds rows too, and the 24 h replay window is only a window if the rows really go.
//
// Reentrant by construction (§4.8.1: "purge is reentrant"): a replayed tick or a racing replica simply matches fewer
// rows. Batched, so one org with a large backlog cannot hold a long transaction. The batch is SELECTed and then DELETEd
// in a second statement, and `putPending` can reclaim an expired key in between (ON CONFLICT DO UPDATE ... WHERE
// expires_at <= now() resets the SAME row id to a fresh 24 h pending claim), so the DELETE re-checks `expires_at` (and
// the org): a delete by id alone would remove a LIVE claim and a retry would run the handler twice. No row is ever
// deleted before its TTL.
import type { DbClient } from "@chartwarden/db";
import { schema } from "@chartwarden/db";
import {
  type PlatformBypassAuditor,
  registerPlatformJob,
  systemOrgContext,
  withOrgContext,
} from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, inArray, lte } from "drizzle-orm";
import { buildActiveOrgEnumerator } from "../active-org-enumerator";
import { safeErrorMessage } from "../redact-database-error";

export const IDEMPOTENCY_CLEANUP_JOB_ID = "platform.idempotency_cleanup";
export const IDEMPOTENCY_CLEANUP_QUEUE = "idempotency.cleanup";
/** Hourly, at minute 20 (offset from the top of the hour where other crons cluster). */
export const IDEMPOTENCY_CLEANUP_SCHEDULE = "20 * * * *";
/** Rows deleted per statement. */
export const IDEMPOTENCY_PURGE_BATCH = 1000;
/** Upper bound of batches per org per tick, so a tick always terminates; the next tick continues. */
export const IDEMPOTENCY_PURGE_MAX_BATCHES = 50;

/**
 * Every `organization_status` (mirrors the pgEnum in `@chartwarden/db`; the unit test pins the two together). The sweeper
 * deletes only rows whose `expires_at` has passed, under each org's own context, so no status needs to be excluded.
 */
export const IDEMPOTENCY_CLEANUP_ORG_STATUSES = [
  "created",
  "active",
  "suspended",
  "closed",
] as const;

export interface IdempotencyCleanupDeps {
  readonly db: DbClient;
  /** Every organization the sweep covers (named for the enumerator's method; the cleanup binds it over ALL statuses). */
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly now?: () => Date;
}

/** The org enumeration the sweeper is bound to: the platform pool, the cleanup's own job id, and every org status. */
export function buildIdempotencyCleanupOrgs(deps: {
  readonly platformDb: DbClient | undefined;
  readonly auditBypass: PlatformBypassAuditor<DbClient>;
}): IdempotencyCleanupDeps["activeOrgs"] {
  return buildActiveOrgEnumerator({
    platformDb: deps.platformDb,
    auditBypass: deps.auditBypass,
    jobId: IDEMPOTENCY_CLEANUP_JOB_ID,
    reason: "M1 idempotency.cleanup cron (every organization status)",
    statuses: [...IDEMPOTENCY_CLEANUP_ORG_STATUSES],
  });
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
      // Still expired AND this org: a row reclaimed since the SELECT is a live claim and survives. `returning` counts what was
      // really deleted (a reclaimed row is not counted).
      const removed = await t
        .delete(T)
        .where(
          and(
            inArray(
              T.id,
              expired.map((r) => r.id),
            ),
            eq(T.organizationId, organizationId),
            lte(T.expiresAt, now),
          ),
        )
        .returning({ id: T.id });
      return removed.length;
    });
    total += deleted;
    if (deleted < IDEMPOTENCY_PURGE_BATCH) break;
  }
  return total;
}

/** One purge pass over every org; a failing org does not stop the others, the pass then rejects. */
export async function runIdempotencyCleanup(deps: IdempotencyCleanupDeps): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  let total = 0;
  const failures: string[] = [];
  for (const { organizationId } of orgs) {
    try {
      total += await purgeOrg(deps, organizationId, now);
    } catch (err) {
      // safeErrorMessage, never err.message: a database error's message carries the query's bound parameters
      failures.push(`${organizationId}: ${safeErrorMessage(err, { bare: true })}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `idempotency.cleanup failed for ${failures.length} org(s): ${failures.join("; ")}`,
    );
  }
  return total;
}

/**
 * The sweeper's worker. It takes the platform pool and the bypass auditor and builds its OWN every-status org enumeration
 * ({@link buildIdempotencyCleanupOrgs}), so the composition root cannot bind it to the active-only default by accident.
 */
export function registerIdempotencyCleanupWorker(
  connection: ConnectionOptions,
  deps: {
    readonly db: DbClient;
    readonly platformDb: DbClient | undefined;
    readonly auditBypass: PlatformBypassAuditor<DbClient>;
    readonly now?: () => Date;
  },
): Worker {
  const cleanup: IdempotencyCleanupDeps = {
    db: deps.db,
    activeOrgs: buildIdempotencyCleanupOrgs({
      platformDb: deps.platformDb,
      auditBypass: deps.auditBypass,
    }),
    ...(deps.now ? { now: deps.now } : {}),
  };
  return new Worker(IDEMPOTENCY_CLEANUP_QUEUE, async () => runIdempotencyCleanup(cleanup), {
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
