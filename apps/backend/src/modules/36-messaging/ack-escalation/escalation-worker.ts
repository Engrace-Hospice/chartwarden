// apps/backend/src/modules/36-messaging/ack-escalation/escalation-worker.ts - WP 4.4 (ADR-0070): the BullMQ shell. Two workers:
//   - `messaging.ack_escalation_timer`: the delayed job for one (request, tier, window); runs `processDue` for that window.
//   - `messaging.ack_escalation_sweep` (every minute): fans out over the active orgs and runs the org sweep, which finds the
//     requests the database says are due whether or not a job exists (a flushed Redis, a lost job, a request nobody could route).
// A job that exhausts its retries (or whose payload is not ids: unrecoverable, no retry) is copied to the declared DLQ queue AND
// recorded as an `m36.dlq_job` audit row (hashed payload, never verbatim). It loses nothing: the sweeper still finds the request.
import {
  type DlqLanding,
  MESSAGING_JOB_SCHEDULES,
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
  buildDlqAuditRecord,
} from "@wardenx/messaging";
import {
  type ConnectionOptions,
  type Job,
  Queue,
  QueueEvents,
  UnrecoverableError,
  Worker,
  type WorkerOptions,
} from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import type { EscalationOutcome, EscalationService, SweepSummary } from "./escalation-service";
import { parseTimerJobData } from "./escalation-timers";

const TIMER_QUEUE = MESSAGING_QUEUES.ackEscalationTimer;
const SWEEP_QUEUE = MESSAGING_QUEUES.ackEscalationSweep;

export interface M36AckEscalationWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly service: EscalationService;
  /** Writes the `m36.dlq_job` audit row for the org the job names. A throw is reported through `onDlqError`, never swallowed. */
  readonly recordDlq: (
    organizationId: string,
    record: ReturnType<typeof buildDlqAuditRecord>,
    requestId: string | null,
  ) => Promise<void>;
  /** Tests only: stall detection timing for the timer worker (a killed worker's job is taken over after `lockDuration`). */
  readonly timerWorkerOptions?: Partial<
    Pick<WorkerOptions, "lockDuration" | "stalledInterval" | "maxStalledCount">
  >;
  readonly onDlqError?: (context: { jobId: string }, error: unknown) => void;
  readonly now?: () => Date;
}

/** One timer job. Returns the outcome (tests and logs). A poison payload never retries. */
export async function timerJobTick(
  deps: Pick<M36AckEscalationWorkerDeps, "service">,
  data: unknown,
): Promise<EscalationOutcome> {
  const job = parseTimerJobData(data);
  if (!job) throw new UnrecoverableError("ack escalation timer payload is not ids and an instant");
  return deps.service.processDue(job.organizationId, job.requestId, {
    tier: job.tier,
    deadlineAt: new Date(job.deadlineAt),
  });
}

/** One sweep tick over every active org; an org-level failure fails the tick (visible in the failed set and the DLQ). */
export async function sweepTick(
  deps: Pick<M36AckEscalationWorkerDeps, "activeOrgs" | "onError" | "service">,
): Promise<SweepSummary> {
  const totals = { escalated: 0, notRouted: 0, skipped: 0, failed: 0 };
  await fanOutOrgs(deps, "ack_escalation_sweep", async (organizationId) => {
    const summary = await deps.service.sweep(organizationId);
    totals.escalated += summary.escalated;
    totals.notRouted += summary.notRouted;
    totals.skipped += summary.skipped;
    totals.failed += summary.failed;
    if (summary.failed > 0)
      throw new Error(`ack escalation sweep: ${summary.failed} request(s) failed`);
  });
  return { flagOff: false, ...totals };
}

/** BullMQ's reason when a job's lock expired more often than `maxStalledCount` allows: it is failed inside Redis, final. */
export const STALLED_LIMIT_REASON = "stalled more than allowable limit";

export const isFinalFailure = (job: Pick<Job, "attemptsMade" | "opts">, error: Error): boolean =>
  error instanceof UnrecoverableError ||
  error.message.includes(STALLED_LIMIT_REASON) ||
  job.attemptsMade >= (job.opts.attempts ?? 1);

// ponytail: process-local, grows by one id per dead job; the DLQ job id is the cross-process dedupe and a replica restart may audit twice.
const landed = new Set<string>();

/** Copy a dead timer job to its DLQ queue and write the audit row. Exposed so a test can drive it without a worker. */
export async function landInDlq(
  deps: Pick<M36AckEscalationWorkerDeps, "recordDlq" | "onDlqError" | "now">,
  dlqQueue: Pick<Queue, "add">,
  job: Pick<Job, "id" | "data">,
  error: Error,
): Promise<void> {
  const jobId = String(job.id ?? "unknown");
  // A job can be reported dead by the Worker AND by the queue events; land it (and audit it) once.
  if (landed.has(jobId)) return;
  landed.add(jobId);
  const failedAt = (deps.now ?? (() => new Date()))().toISOString();
  const landing: DlqLanding = {
    queue: TIMER_QUEUE,
    jobId,
    jobData: job.data,
    failedAt,
    finalError: error.name,
  };
  try {
    await dlqQueue.add("dead", job.data, { jobId: `${jobId}-dlq`, removeOnComplete: false });
    const parsed = parseTimerJobData(job.data);
    // A payload that names no organization cannot be audited per tenant; the DLQ copy and the ops alert still stand.
    if (parsed) {
      await deps.recordDlq(parsed.organizationId, buildDlqAuditRecord(landing), parsed.requestId);
    }
  } catch (dlqError) {
    landed.delete(jobId); // a failed landing may be tried again by the other report of the same death
    deps.onDlqError?.({ jobId }, dlqError);
  }
}

/** Construct the two Workers (the caller owns lifecycle) and the DLQ queue to `close()`. */
export function registerM36AckEscalationWorkers(deps: M36AckEscalationWorkerDeps): {
  readonly workers: Worker[];
  readonly dlqQueue: Queue;
  /** Listens for jobs BullMQ fails inside Redis (stalled too often): the Worker itself emits no `failed` for those. */
  readonly events: QueueEvents;
  readonly timerQueue: Queue;
} {
  const dlqQueue = new Queue(MESSAGING_QUEUE_PARAMETERS[TIMER_QUEUE].dlq, {
    connection: deps.connection,
  });
  const timerQueue = new Queue(TIMER_QUEUE, { connection: deps.connection });
  const timer = new Worker(TIMER_QUEUE, (job) => timerJobTick(deps, job.data), {
    connection: deps.connection,
    concurrency: MESSAGING_QUEUE_PARAMETERS[TIMER_QUEUE].concurrency,
    ...deps.timerWorkerOptions,
  });
  timer.on("failed", (job, error) => {
    if (job && isFinalFailure(job, error)) void landInDlq(deps, dlqQueue, job, error);
  });
  const events = new QueueEvents(TIMER_QUEUE, { connection: deps.connection });
  events.on("failed", ({ jobId, failedReason }) => {
    if (!failedReason.includes(STALLED_LIMIT_REASON)) return; // every other failure is handled by the worker's own event
    void timerQueue
      .getJob(jobId)
      .then((job) => (job ? landInDlq(deps, dlqQueue, job, new Error(failedReason)) : undefined))
      .catch((error) => deps.onDlqError?.({ jobId }, error));
  });
  const sweep = new Worker(SWEEP_QUEUE, () => sweepTick(deps), {
    connection: deps.connection,
    concurrency: MESSAGING_QUEUE_PARAMETERS[SWEEP_QUEUE].concurrency,
  });
  return { workers: [timer, sweep], dlqQueue, events, timerQueue };
}

/** Register the repeatable sweep trigger (idempotent under a fixed scheduler id). Returns the `Queue`s to `close()`. */
export async function scheduleM36AckEscalationJobs(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(SWEEP_QUEUE, { connection });
  const { attempts, backoff } = MESSAGING_QUEUE_PARAMETERS[SWEEP_QUEUE];
  try {
    await queue.upsertJobScheduler(
      `${SWEEP_QUEUE}.schedule`,
      { pattern: MESSAGING_JOB_SCHEDULES.ackEscalationSweep },
      {
        name: "sweep",
        data: {},
        opts: {
          removeOnComplete: true,
          attempts,
          backoff: { type: backoff.type, delay: backoff.baseMs },
        },
      },
    );
  } catch (error) {
    await queue.close();
    throw error;
  }
  return [queue];
}
