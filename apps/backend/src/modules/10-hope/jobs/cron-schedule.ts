// apps/backend/src/modules/10-hope/jobs/cron-schedule.ts — the M10 §4.8 repeatable cron REGISTRATION (which schedules exist,
// under which scheduler ids, with which attempts/backoff), split out of `cron-workers.ts` (which builds the Workers; the
// watchdog ticks live in ./watchdog-ticks.ts). Nothing here runs at import: a `Queue` opens Valkey when `scheduleM10Jobs`
// constructs it.
import { type ConnectionOptions, Queue } from "bullmq";
import { type M10QueueName, M10_JOB_PARAMS, M10_JOB_SCHEDULES, M10_QUEUES } from "./index";

/** The three job names this file schedules: the two watchdogs and the monthly retention scan (a narrower key set than
 * `M10_JOB_PARAMS`/`M10_JOB_SCHEDULES`, which also carry the §4.8 jobs that are not scheduled). */
type M10ScheduledJobName = "hope-retention-scan" | "hope-window-watchdog" | "sfv-watchdog";

/** The §4.8.1 catalog's string-form backoff (e.g. `"exponential 30s"`) parsed into BullMQ's `{type,delay}`
 * shape. Only the base delay is used; none of the three scheduled jobs' catalog entries carries a `, max …` clause. */
interface ParsedBackoff {
  readonly type: "exponential" | "fixed";
  readonly delay: number;
}

const DURATION_UNIT_MS: Record<"s" | "m" | "h", number> = { s: 1_000, m: 60_000, h: 3_600_000 };

function parseBackoff(spec: string): ParsedBackoff {
  const [head] = spec.split(",");
  const [type, duration] = (head ?? "").trim().split(/\s+/);
  const match = /^(\d+)(s|m|h)$/.exec(duration ?? "");
  if ((type !== "exponential" && type !== "fixed") || !match) {
    throw new Error(`M10_WORKER_BACKOFF_UNPARSEABLE: ${spec}`);
  }
  const amount = match[1] as string;
  const unit = match[2] as "s" | "m" | "h";
  return { type, delay: Number(amount) * DURATION_UNIT_MS[unit] };
}

/** The job name a scheduled tick carries. Kept as the literal "scheduled" (not the job name): the workers do not dispatch
 * on it, and renaming it would orphan the repeatable an earlier deploy stored under it. The job name only matters as a
 * dispatch key on the shared `hope.submission` queue, which is not scheduled here. */
const SCHEDULED_JOB_NAME = "scheduled";

/** The one scheduler id per queue. Any other trigger registered under the job name is a stale (legacy) one. */
export const m10SchedulerId = (queueName: string): string => `${queueName}.schedule`;

/**
 * Register the wired §4.8 repeatable cron schedules on their dedicated queues with `upsertJobScheduler`. Returns the
 * `Queue`s to `close()`.
 *
 * Why not `queue.add(..., { repeat })`: BullMQ keeps the first-registered delayed job and its options, and every later
 * firing copies them, so changing attempts/backoff on an already-registered repeat key has no effect (the two watchdogs'
 * `attempts: 1` would never reach an environment that already held the repeatable with 5). Upserting under a fixed
 * scheduler id is idempotent and replaces the options on every boot. A legacy `add({ repeat })` trigger an earlier deploy
 * left in Redis would run beside the scheduler (two ticks per firing), so every other trigger under the job name is
 * removed AFTER the upsert succeeded (a failed upsert leaves the legacy trigger, never zero schedules). During a rolling
 * deploy an old replica that still registers the legacy trigger can re-create it until a new replica next boots: a
 * transient double tick, which the watchdogs absorb (every write is keyed on the status it was planned from and every
 * alert is deduped on `(org, correlationId)`). Same shape as M36's `scheduleM36IntegrityJobs`.
 */
export async function scheduleM10Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const jobs: readonly [M10QueueName, M10ScheduledJobName][] = [
    [M10_QUEUES.windows, "hope-window-watchdog"],
    [M10_QUEUES.sfv, "sfv-watchdog"],
    [M10_QUEUES.retention, "hope-retention-scan"],
    // NOT scheduled: `assemble-hope-submission` / `iqies-submit-worker` / `iqies-reconcile-worker` — see
    // the RECOVERY NOTE in the header of ./cron-workers.ts (they conflict with the manual iQIES package flow).
  ];
  const queues: Queue[] = [];
  try {
    for (const [queueName, jobName] of jobs) {
      const params = M10_JOB_PARAMS[jobName];
      const queue = new Queue(queueName, { connection });
      queues.push(queue);
      const schedulerId = m10SchedulerId(queueName);
      await queue.upsertJobScheduler(
        schedulerId,
        { pattern: M10_JOB_SCHEDULES[jobName] },
        {
          name: SCHEDULED_JOB_NAME,
          data: {},
          opts: {
            attempts: params.attempts,
            backoff: parseBackoff(params.backoff),
            removeOnComplete: true,
            removeOnFail: false,
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
    await Promise.allSettled(queues.map((queue) => queue.close()));
    throw error;
  }
}
