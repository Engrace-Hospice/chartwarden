// apps/backend/src/modules/41-billing-commercial/jobs/schedule-probe.ts - ask the shared queue store whether the M41 repeatable schedules
// exist. The API process of a split deployment (PROCESS_ROLE=api) never registers them (TASK-040A: an API replica must not re-register
// crons or compete for jobs; the worker process does), so it READS them instead. Read-only: nothing is created, nothing is removed.
import { type ConnectionOptions, Queue } from "bullmq";
import IORedis, { type RedisOptions } from "ioredis";
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
  /** Force-end the connection now (BullMQ `Queue.disconnect`). `close()` alone waits for QUIT, which never returns on a dead store. */
  disconnect(): Promise<void>;
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
  /**
   * The default path OWNS one ioredis client shared by both queues (BullMQ never closes a client it was handed). A bare `Queue` opens a
   * second hidden connection for its repeat store, and neither `close()` (waits for QUIT) nor `disconnect()` (main connection only)
   * frees both against a dead store; ending the one client we own frees everything, at once, in every state.
   */
  let owned: IORedis | undefined;
  const make =
    options.makeQueue ??
    ((name: string, connection: ConnectionOptions): RepeatableLister => {
      if (!owned) {
        owned = new IORedis({ ...(connection as RedisOptions), maxRetriesPerRequest: null });
        owned.on("error", () => undefined); // a down store is reported through the probe's rejection, not an unhandled 'error'
      }
      const queue = new Queue(name, { connection: owned });
      queue.on("error", () => undefined);
      return queue;
    });
  const queues = new Map<string, RepeatableLister>();
  const queueFor = (name: string): RepeatableLister => {
    let q = queues.get(name);
    if (!q) {
      q = make(name, options.connection);
      queues.set(name, q);
    }
    return q;
  };
  /**
   * Drop every cached queue so the next probe builds a fresh one (a queue whose connection failed is never reused) and TEAR IT DOWN.
   * `close()` alone leaks against a dead store: on a connection that was once ready it waits for QUIT, which sits in the offline queue
   * while the client retries forever. `disconnect()` ends the client at once, but waits on a connection that never became ready, where
   * `close()` is the call that disconnects. Both are started (allSettled, and a probe's own reset never waits for it), so every state is covered.
   */
  const teardown = (q: RepeatableLister): Promise<unknown> =>
    Promise.allSettled([q.disconnect(), q.close()]);
  const reset = (): Promise<unknown> => {
    const open = [...queues.values()];
    queues.clear();
    owned?.disconnect(); // synchronous and final: the socket is gone before anything below is awaited
    owned = undefined;
    return Promise.all(open.map(teardown));
  };
  const look = async (abandoned: () => boolean): Promise<boolean> => {
    for (const { queue, pattern } of expected) {
      // a probe that already timed out must not build a new queue behind the reset (it would be cached and never torn down)
      if (abandoned()) throw new Error("schedule probe abandoned");
      const jobs = await queueFor(queue).getRepeatableJobs();
      if (!jobs.some((j) => j.pattern === pattern)) return false;
    }
    return true;
  };
  const probe = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("schedule probe timed out")), timeoutMs);
    });
    try {
      return await Promise.race([look(() => abandoned), deadline]);
    } catch (err) {
      abandoned = true;
      void reset();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.assign(probe, {
    close: async (): Promise<void> => {
      await reset(); // shutdown must not hang on a dead store either
    },
  });
}
