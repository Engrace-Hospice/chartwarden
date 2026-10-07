// apps/backend/src/modules/31-portal/jobs/cron-workers.ts — the BullMQ Worker + repeatable Queue for M31's
// `m31.post-discharge-grace.cron` (F-222, #248). The M29 `registerM29OutboundRetrySweepWorker` /
// `scheduleM29OutboundRetrySweepJob` template: the processor is `runPostDischargeGraceSweepOnce`, driven
// directly by tests without BullMQ.
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type LateJoinWatchdogDeps, runLateJoinWatchdogOnce } from "./late-join-watchdog";
import {
  type PostDischargeGraceSweepDeps,
  runPostDischargeGraceSweepOnce,
} from "./post-discharge-grace-sweep";
import { M31_CRON_QUEUES, M31_JOB_SCHEDULES, M31_QUEUE_PARAMS } from "./queues";

/** Construct the Worker. The caller owns the lifecycle (`close()` on shutdown). */
export function registerM31PostDischargeGraceWorker(
  deps: PostDischargeGraceSweepDeps & { readonly connection: ConnectionOptions },
): Worker {
  return new Worker(
    M31_CRON_QUEUES.postDischargeGrace,
    async () => {
      const results = await runPostDischargeGraceSweepOnce(deps);
      return results.map((r) => ({
        organizationId: r.organizationId,
        revokedPatients: r.revokedPatients,
        revokedGrants: r.revokedGrants,
        capped: r.capped,
      }));
    },
    {
      connection: deps.connection,
      concurrency: M31_QUEUE_PARAMS.postDischargeGrace.concurrency,
    },
  );
}

/** Register the repeatable daily schedule. Returns the Queue so the composition root can `close()` it. */
export async function scheduleM31PostDischargeGraceJob(
  connection: ConnectionOptions,
): Promise<Queue> {
  const queue = new Queue(M31_CRON_QUEUES.postDischargeGrace, { connection });
  await queue.add(
    "tick",
    {},
    { repeat: { pattern: M31_JOB_SCHEDULES.postDischargeGrace, tz: "UTC" } },
  );
  return queue;
}

/** GAP-159 - the 5-minute telehealth late-join watchdog Worker. */
export function registerM31LateJoinWatchdogWorker(
  deps: LateJoinWatchdogDeps & { readonly connection: ConnectionOptions },
): Worker {
  return new Worker(M31_CRON_QUEUES.lateJoinWatchdog, async () => runLateJoinWatchdogOnce(deps), {
    connection: deps.connection,
    concurrency: M31_QUEUE_PARAMS.lateJoinWatchdog.concurrency,
  });
}

/** GAP-159 - register the watchdog's repeatable schedule; returns the Queue for the root to `close()`. */
export async function scheduleM31LateJoinWatchdogJob(
  connection: ConnectionOptions,
): Promise<Queue> {
  const queue = new Queue(M31_CRON_QUEUES.lateJoinWatchdog, { connection });
  await queue.add(
    "tick",
    {},
    { repeat: { pattern: M31_JOB_SCHEDULES.lateJoinWatchdog, tz: "UTC" } },
  );
  return queue;
}
