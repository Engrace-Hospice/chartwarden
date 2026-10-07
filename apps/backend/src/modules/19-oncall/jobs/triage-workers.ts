// apps/backend/src/modules/19-oncall/jobs/triage-workers.ts — BullMQ construction for the four non-Tier-1 §4.8
// queues (GAP-057 follow-up): `m19.callback-sla.cron`, `m19.awaiting-callback-timeout.cron`,
// `m19.close-documented.cron`, `m19.escalation-sla`. The ticks live in their own files; this is only the
// Worker/Queue wiring, the `tier1-workers.ts` template (same DLQ convention: `removeOnFail: false` keeps the
// queue's failed set as the de facto DLQ, named by `M19_DLQ`).
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import { runAwaitingCallbackTimeoutTick } from "./awaiting-callback-timeout";
import { runCallbackSlaTick } from "./callback-sla";
import { runCloseDocumentedTick } from "./close-documented";
import { runEscalationSlaTick } from "./escalation-sla";
import {
  M19_AWAITING_CALLBACK_TIMEOUT_JOB_NAME,
  M19_CALLBACK_SLA_JOB_NAME,
  M19_CLOSE_DOCUMENTED_JOB_NAME,
  M19_ESCALATION_SLA_JOB_NAME,
  M19_JOB_SCHEDULES,
  M19_QUEUES,
  M19_QUEUE_PARAMS,
} from "./index";
import type { M19TriageCronDeps } from "./triage-cron-common";
import { parseBackoff } from "./worker";

export type M19TriageWorkerDeps = M19TriageCronDeps & { readonly connection: ConnectionOptions };

const TRIAGE_CRONS = [
  {
    queue: M19_QUEUES.callbackSla,
    jobName: M19_CALLBACK_SLA_JOB_NAME,
    everyMs: M19_JOB_SCHEDULES.callbackSlaEveryMs,
    params: M19_QUEUE_PARAMS.callbackSla,
    tick: runCallbackSlaTick,
  },
  {
    queue: M19_QUEUES.awaitingCallbackTimeout,
    jobName: M19_AWAITING_CALLBACK_TIMEOUT_JOB_NAME,
    everyMs: M19_JOB_SCHEDULES.awaitingCallbackTimeoutEveryMs,
    params: M19_QUEUE_PARAMS.awaitingCallbackTimeout,
    tick: runAwaitingCallbackTimeoutTick,
  },
  {
    queue: M19_QUEUES.closeDocumented,
    jobName: M19_CLOSE_DOCUMENTED_JOB_NAME,
    everyMs: M19_JOB_SCHEDULES.closeDocumentedEveryMs,
    params: M19_QUEUE_PARAMS.closeDocumented,
    tick: runCloseDocumentedTick,
  },
  {
    queue: M19_QUEUES.escalationSla,
    jobName: M19_ESCALATION_SLA_JOB_NAME,
    everyMs: M19_JOB_SCHEDULES.escalationSlaEveryMs,
    params: M19_QUEUE_PARAMS.escalationSla,
    tick: runEscalationSlaTick,
  },
] as const;

/** Construct the four live `Worker`s (the caller owns lifecycle — `close()` on shutdown). */
export function registerM19TriageCronWorkers(deps: M19TriageWorkerDeps): Worker[] {
  return TRIAGE_CRONS.map(
    (c) =>
      new Worker(
        c.queue,
        async () => {
          await c.tick(deps);
        },
        { connection: deps.connection, concurrency: c.params.concurrency },
      ),
  );
}

/** Register the four repeatable schedules; returns the `Queue`s so the composition root can `close()` them. */
export async function scheduleM19TriageJobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (const c of TRIAGE_CRONS) {
    const queue = new Queue(c.queue, { connection });
    queues.push(queue);
    await queue.add(
      c.jobName,
      {},
      {
        repeat: { every: c.everyMs },
        priority: c.params.priority,
        attempts: c.params.attempts,
        backoff: parseBackoff(c.params.backoff),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }
  return queues;
}
