// apps/backend/src/modules/19-oncall/jobs/tier1-workers.ts — BullMQ construction for the three §4.8 Tier-1
// queues (GAP-057): `m19.shift-open.cron`, `m19.shift-close.cron`, `m19.coverage-gap-watchdog.cron`. The ticks
// themselves live in `./shift-cron` and `./coverage-gap-watchdog`; this file is only the Worker/Queue wiring,
// the M9/M12/M20 `registerMxCronWorkers` / `scheduleMxJobs` template (the roster-sync pair is in `./worker`).
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import { type M19CoverageGapDeps, runCoverageGapWatchdogTick } from "./coverage-gap-watchdog";
import {
  M19_COVERAGE_GAP_WATCHDOG_JOB_NAME,
  M19_JOB_SCHEDULES,
  M19_QUEUES,
  M19_QUEUE_PARAMS,
  M19_SHIFT_CLOSE_JOB_NAME,
  M19_SHIFT_OPEN_JOB_NAME,
} from "./index";
import { type M19ShiftCronDeps, runShiftCloseTick, runShiftOpenTick } from "./shift-cron";
import { parseBackoff } from "./worker";

export type M19Tier1WorkerDeps = M19ShiftCronDeps &
  M19CoverageGapDeps & { readonly connection: ConnectionOptions };

/** Construct the three live Tier-1 `Worker`s (the caller owns lifecycle — `close()` on shutdown). */
export function registerM19Tier1CronWorkers(deps: M19Tier1WorkerDeps): Worker[] {
  const opts = (concurrency: number) => ({ connection: deps.connection, concurrency });
  return [
    new Worker(
      M19_QUEUES.shiftOpen,
      async () => {
        await runShiftOpenTick(deps);
      },
      opts(M19_QUEUE_PARAMS.shiftOpen.concurrency),
    ),
    new Worker(
      M19_QUEUES.shiftClose,
      async () => {
        await runShiftCloseTick(deps);
      },
      opts(M19_QUEUE_PARAMS.shiftClose.concurrency),
    ),
    new Worker(
      M19_QUEUES.coverageGapWatchdog,
      async () => {
        await runCoverageGapWatchdogTick(deps);
      },
      opts(M19_QUEUE_PARAMS.coverageGapWatchdog.concurrency),
    ),
  ];
}

const TIER1_SCHEDULES = [
  {
    queue: M19_QUEUES.shiftOpen,
    jobName: M19_SHIFT_OPEN_JOB_NAME,
    everyMs: M19_JOB_SCHEDULES.shiftOpenEveryMs,
    params: M19_QUEUE_PARAMS.shiftOpen,
  },
  {
    queue: M19_QUEUES.shiftClose,
    jobName: M19_SHIFT_CLOSE_JOB_NAME,
    everyMs: M19_JOB_SCHEDULES.shiftCloseEveryMs,
    params: M19_QUEUE_PARAMS.shiftClose,
  },
  {
    queue: M19_QUEUES.coverageGapWatchdog,
    jobName: M19_COVERAGE_GAP_WATCHDOG_JOB_NAME,
    everyMs: M19_JOB_SCHEDULES.coverageGapWatchdogEveryMs,
    params: M19_QUEUE_PARAMS.coverageGapWatchdog,
  },
] as const;

/** Register the three repeatable schedules; returns the `Queue`s so the composition root can `close()` them. */
export async function scheduleM19Tier1Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (const s of TIER1_SCHEDULES) {
    const queue = new Queue(s.queue, { connection });
    queues.push(queue);
    await queue.add(
      s.jobName,
      {},
      {
        repeat: { every: s.everyMs },
        priority: s.params.priority,
        attempts: s.params.attempts,
        backoff: parseBackoff(s.params.backoff),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
  return queues;
}
