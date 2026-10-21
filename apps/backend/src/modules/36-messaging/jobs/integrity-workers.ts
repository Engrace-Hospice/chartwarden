// apps/backend/src/modules/36-messaging/jobs/integrity-workers.ts — WP 1.9 (audit F8): the BullMQ shell that
// finally RUNS `messaging.hash_verify` (nightly 04:00 UTC) and `messaging.retention_scan` (weekly, Sunday 02:00 UTC)
// on the cadences `MESSAGING_JOB_SCHEDULES` already declared. Queue names come from `MESSAGING_QUEUES` (this
// package is their one owner, `arch:queue-names`). Each tick fans out over active orgs; one org failing never
// stops the others, and the tick then FAILS (AggregateError) so the failure is visible in the failed set / DLQ alert
// rather than reported green. A hash mismatch is such a failure.
import {
  MESSAGING_JOB_SCHEDULES,
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
} from "@chartwarden/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  type M36IntegrityJobDeps,
  runHashVerifyForOrg,
  runRetentionScanForOrg,
} from "./integrity-jobs";

export interface M36IntegrityWorkerDeps extends M36IntegrityJobDeps {
  readonly connection: ConnectionOptions;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly onError?: (context: { organizationId: string; job: string }, error: unknown) => void;
}

/** Run `perOrg` for every active org; throw one AggregateError after all orgs were attempted. */
export async function fanOutOrgs(
  deps: Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError">,
  job: string,
  perOrg: (organizationId: string) => Promise<void>,
): Promise<number> {
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const errors: unknown[] = [];
  for (const { organizationId } of orgs) {
    try {
      await perOrg(organizationId);
    } catch (error) {
      errors.push(error);
      deps.onError?.({ organizationId, job }, error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `M36 ${job} failed for ${errors.length} of ${orgs.length} org(s)`,
    );
  }
  return orgs.length;
}

/** The org-level body of one hash-verify tick: a mismatch makes the org's run fail the tick. */
export async function hashVerifyTick(deps: M36IntegrityWorkerDeps): Promise<number> {
  return fanOutOrgs(deps, "hash_verify", async (organizationId) => {
    const result = await runHashVerifyForOrg(deps, organizationId);
    if (result.mismatched > 0) {
      throw new Error(
        `M36 hash_verify: ${result.mismatched} mismatch(es) in org ${organizationId} (run ${result.runId})`,
      );
    }
  });
}

export async function retentionScanTick(deps: M36IntegrityWorkerDeps): Promise<number> {
  return fanOutOrgs(deps, "retention_scan", async (organizationId) => {
    await runRetentionScanForOrg(deps, organizationId);
  });
}

/** Construct the two Workers (the caller owns lifecycle). Concurrency comes from the §4.4.1 parameter table. */
export function registerM36IntegrityWorkers(deps: M36IntegrityWorkerDeps): Worker[] {
  const options = (queue: keyof typeof MESSAGING_QUEUE_PARAMETERS) => ({
    connection: deps.connection,
    concurrency: MESSAGING_QUEUE_PARAMETERS[queue].concurrency,
  });
  return [
    new Worker(
      MESSAGING_QUEUES.hashVerify,
      () => hashVerifyTick(deps),
      options(MESSAGING_QUEUES.hashVerify),
    ),
    new Worker(
      MESSAGING_QUEUES.retentionScan,
      () => retentionScanTick(deps),
      options(MESSAGING_QUEUES.retentionScan),
    ),
  ];
}

const SCHEDULED_JOB_NAME = "scheduled";

/** The one scheduler id per queue. Anything else registered under the job name is a stale (legacy) trigger. */
export const integritySchedulerId = (queueName: string): string => `${queueName}.schedule`;

/**
 * Register the repeatable triggers with `upsertJobScheduler`. Returns the `Queue`s to `close()`.
 *
 * Why not `queue.add(..., { repeat })`: BullMQ keeps the first-registered delayed job and its options, so changing
 * attempts/backoff (or the cron) on an already-registered repeat key has no effect, and the old key keeps firing
 * (observed against the real BullMQ 5.81 in `m36-integrity-jobs.live.test.ts`). Upserting under a fixed scheduler id
 * is idempotent and replaces the options. A legacy `add({ repeat })` trigger left in Redis by an earlier deploy
 * would run beside the scheduler (two runs per tick), so every other trigger under this job name is removed AFTER the
 * upsert succeeded. During a rolling deploy an old replica that still registers the legacy trigger can re-create it until
 * a new replica next boots: a transient, harmless double run.
 *
 * Attempts/backoff come from the §4.4.1 table (hash_verify is 1 attempt by design: see the table). The DLQ alert keys
 * on `attemptsMade >= opts.attempts`, so the job option must carry the table value.
 */
export async function scheduleM36IntegrityJobs(connection: ConnectionOptions): Promise<Queue[]> {
  const specs = [
    { name: MESSAGING_QUEUES.hashVerify, pattern: MESSAGING_JOB_SCHEDULES.hashVerify },
    { name: MESSAGING_QUEUES.retentionScan, pattern: MESSAGING_JOB_SCHEDULES.retentionScan },
  ];
  const queues: Queue[] = [];
  try {
    for (const { name, pattern } of specs) {
      const { attempts, backoff } = MESSAGING_QUEUE_PARAMETERS[name];
      const queue = new Queue(name, { connection });
      queues.push(queue);
      const schedulerId = integritySchedulerId(name);
      // Upsert FIRST: if it fails (Redis blip) the legacy trigger is still there, so the queue is never left with no
      // schedule. A failed removal afterwards only leaves a harmless double run (read-only, concurrency 1).
      await queue.upsertJobScheduler(
        schedulerId,
        { pattern },
        {
          name: SCHEDULED_JOB_NAME,
          data: {},
          opts: {
            removeOnComplete: true,
            attempts,
            backoff: { type: backoff.type, delay: backoff.baseMs },
          },
        },
      );
      for (const stale of await queue.getRepeatableJobs()) {
        if (stale.name === SCHEDULED_JOB_NAME && stale.key !== schedulerId) {
          await queue.removeRepeatableByKey(stale.key);
        }
      }
    }
    return queues;
  } catch (error) {
    await Promise.allSettled(queues.map((q) => q.close()));
    throw error;
  }
}
