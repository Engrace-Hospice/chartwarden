// apps/backend/src/modules/41-billing-commercial/jobs/schedule-probe.ts - ask the shared queue store whether the M41 repeatable schedules
// exist. The API process of a split deployment (PROCESS_ROLE=api) never registers them (TASK-040A: an API replica must not re-register
// crons or compete for jobs; the worker process does), so it READS them instead. Read-only: nothing is created, nothing is removed.
import { type ConnectionOptions, Queue } from "bullmq";
import { M41_CRON_QUEUES, M41_JOB_SCHEDULES } from "./queues";

/** One schedule the drain needs: the queue and the cron pattern its repeatable job carries. */
export interface ExpectedSchedule {
  readonly queue: string;
  readonly pattern: string;
}

export const M41_EXPECTED_SCHEDULES: readonly ExpectedSchedule[] = [
  { queue: M41_CRON_QUEUES.submissionDrain, pattern: M41_JOB_SCHEDULES.submissionDrain },
  { queue: M41_CRON_QUEUES.ackPull, pattern: M41_JOB_SCHEDULES.ackPull },
];

/** The slice of a BullMQ queue the probe uses (injectable for tests). */
export interface RepeatableLister {
  getRepeatableJobs(): Promise<readonly { readonly pattern?: string | null }[]>;
  close(): Promise<void>;
}

export interface ScheduleProbe {
  /** True only when EVERY expected schedule exists. A Valkey fault rejects (the caller treats that as not scheduled). */
  (): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * A probe that has not answered in this long counts as "not scheduled". The Valkey client retries without limit, so during an outage a
 * call would otherwise never return and every request waiting on the probe would hang with it.
 */
export const SCHEDULE_PROBE_TIMEOUT_MS = 2_000;

export function createScheduleProbe(options: {
  readonly connection: ConnectionOptions;
  readonly expected?: readonly ExpectedSchedule[];
  readonly makeQueue?: (name: string, connection: ConnectionOptions) => RepeatableLister;
  readonly timeoutMs?: number;
}): ScheduleProbe {
  const timeoutMs = options.timeoutMs ?? SCHEDULE_PROBE_TIMEOUT_MS;
  const expected = options.expected ?? M41_EXPECTED_SCHEDULES;
  const make =
    options.makeQueue ??
    ((name: string, connection: ConnectionOptions): RepeatableLister =>
      new Queue(name, { connection }));
  const queues = new Map<string, RepeatableLister>();
  const queueFor = (name: string): RepeatableLister => {
    let q = queues.get(name);
    if (!q) {
      q = make(name, options.connection);
      queues.set(name, q);
    }
    return q;
  };
  /** Drop every cached queue so the next probe builds a fresh one (a queue whose connection failed is never reused). Never waits. */
  const reset = (): void => {
    for (const q of queues.values()) void q.close().catch(() => undefined);
    queues.clear();
  };
  const look = async (): Promise<boolean> => {
    for (const { queue, pattern } of expected) {
      const jobs = await queueFor(queue).getRepeatableJobs();
      if (!jobs.some((j) => j.pattern === pattern)) return false;
    }
    return true;
  };
  const probe = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("schedule probe timed out")), timeoutMs);
    });
    try {
      return await Promise.race([look(), deadline]);
    } catch (err) {
      reset();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.assign(probe, {
    close: async (): Promise<void> => {
      await Promise.all([...queues.values()].map((q) => q.close()));
      queues.clear();
    },
  });
}
