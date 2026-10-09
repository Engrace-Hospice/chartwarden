// apps/backend/src/modules/23-billing-medicare/jobs/legacy-validation-queue.ts — one-shot recovery of M23 jobs stranded
// on the pre-rename shared `validation-run` queue.
//
// WHY. M23 and M27 both enqueued onto a queue literally named `validation-run`, so either module's worker could pick up
// the other's job (an M27 worker failed an M23 job — "cost_report_validation … not found" — and sent it to the DLQ).
// M23 now owns `m23.validation-run`. Jobs that were already in the old queue when this shipped are still M23's work:
// a claim sitting in VALIDATING whose run was never executed. Nothing listens for them on the old name except M27's
// worker, which can only fail them. So at boot we MOVE them, never drop them.
//
// SAFETY / IDEMPOTENCY.
//   - Only jobs whose id starts `m23:` move (M27's job ids never do), so M27's own work is untouched.
//   - The job id is preserved (`m23JobId` is queue-rename-stable), so BullMQ's jobId dedupe makes a repeat add a no-op:
//     add-then-remove means a crash between the two steps re-runs harmlessly, and a restart sweeps again for free.
//   - Waiting, delayed, prioritized, paused and FAILED jobs move; a failed M23 job there failed only because the wrong
//     module's worker ran it (it was never executed by M23), and the validation-run executor settles a stale or repeated
//     run quietly (GAP-070), so re-running is the correct recovery. Fresh attempts/backoff come from the M23 catalog.
//   - An ACTIVE job is locked by a live worker and cannot be removed; it is skipped and reported, and the next boot's
//     sweep (or its own failure landing in `failed`) picks it up.
import { type ConnectionOptions, type Job, type JobType, Queue } from "bullmq";
import { M23_LEGACY_VALIDATION_RUN_QUEUE, M23_QUEUES, M23_QUEUE_PARAMS } from "./queues";

/** The slice of a BullMQ `Queue` the migration needs (so a unit test can fake it). */
export interface LegacyQueuePort {
  getJobs(types: JobType[], start?: number, end?: number): Promise<Job[]>;
}
export interface TargetQueuePort {
  add(
    name: string,
    data: unknown,
    opts: {
      jobId: string;
      delay?: number;
      attempts: number;
      backoff: { type: "exponential" | "fixed"; delay: number };
      removeOnComplete: { count: number };
      removeOnFail: boolean;
    },
  ): Promise<unknown>;
}

export interface LegacyValidationMigrationResult {
  readonly moved: number;
  /** M23 jobs left in place because a live worker holds them (active). */
  readonly skippedActive: number;
  /** Jobs that are not M23's and were deliberately left alone. */
  readonly leftForOtherModules: number;
}

const MOVABLE_STATES: JobType[] = ["waiting", "delayed", "prioritized", "paused", "failed"];
const PAGE = 200;
const M23_JOB_ID_PREFIX = "m23:";

/** Read every movable job id first (no removal while paging), so paging cannot skip or loop. */
async function listMovableJobs(legacy: LegacyQueuePort): Promise<Job[]> {
  const all: Job[] = [];
  for (let start = 0; ; start += PAGE) {
    const page = await legacy.getJobs(MOVABLE_STATES, start, start + PAGE - 1);
    all.push(...page);
    if (page.length < PAGE) return all;
  }
}

/** Move M23's validation jobs from the old shared queue to `m23.validation-run`. Never drops a job. */
export async function migrateLegacyValidationRunJobs(
  legacy: LegacyQueuePort,
  target: TargetQueuePort,
  now: () => number = Date.now,
): Promise<LegacyValidationMigrationResult> {
  const params = M23_QUEUE_PARAMS.validationRun;
  const jobs = await listMovableJobs(legacy);
  const mine = jobs.filter((j) => j.id?.startsWith(M23_JOB_ID_PREFIX));
  for (const job of mine) {
    const remainingDelay = Math.max(0, job.timestamp + (job.opts.delay ?? 0) - now());
    // Add first, remove second: a crash in between leaves a duplicate id, which BullMQ dedupes on the next sweep.
    await target.add(M23_QUEUES.validationRun, job.data, {
      jobId: job.id as string,
      ...(remainingDelay > 0 ? { delay: remainingDelay } : {}),
      attempts: params.attempts,
      backoff: params.backoff,
      removeOnComplete: { count: 500 },
      removeOnFail: false,
    });
    await job.remove();
  }
  const active = await legacy.getJobs(["active"]);
  return {
    moved: mine.length,
    skippedActive: active.filter((j) => j.id?.startsWith(M23_JOB_ID_PREFIX)).length,
    leftForOtherModules: jobs.length - mine.length,
  };
}

/**
 * Boot-time sweep over real Redis queues. Errors are returned to the caller to log (a Redis hiccup must not stop the
 * worker from booting; the sweep is idempotent and runs again on the next boot).
 */
export async function sweepLegacyValidationRunQueue(
  connection: ConnectionOptions,
): Promise<LegacyValidationMigrationResult> {
  const legacy = new Queue(M23_LEGACY_VALIDATION_RUN_QUEUE, { connection });
  const target = new Queue(M23_QUEUES.validationRun, { connection });
  try {
    return await migrateLegacyValidationRunJobs(legacy, target);
  } finally {
    await Promise.all([legacy.close(), target.close()]);
  }
}
