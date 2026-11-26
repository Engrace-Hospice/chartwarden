// apps/backend/src/modules/22-documents/extraction/intake-queue.ts — the BullMQ queue the DocLens intake
// job runs on (F-236). The route enqueues; the WORKER process runs `runDocLensIntake` (concurrency 1: a
// local model serves one extraction at a time, and a batch's stages are sequential anyway).
//
// One job per batch at a time: the job id is the batch id, so a double-click re-enqueue is collapsed by
// BullMQ while the first is queued or running; the job itself is idempotent on batch status afterwards.
// A job that FAILED (every attempt spent — e.g. the docling-worker was down) is kept for inspection, and
// BullMQ silently ignores `add` for an id it still holds, so a re-run answered 202 "queued" and did nothing
// (F-238 E2E). Enqueue therefore removes a failed job of the same id first.
import { type ConnectionOptions, type Job, Queue, Worker } from "bullmq";
import { DoclingParseError } from "./docling-client";
import {
  type DocLensIntakeDeps,
  type DocLensIntakeJob,
  type DocLensIntakeSummary,
  type DocLensTerminalFailureCode,
  markDocLensIntakeFailed,
  runDocLensIntake,
} from "./intake-job";

export const M22_DOCLENS_INTAKE_QUEUE = "m22-doclens-intake";

export interface DocLensIntakeEnqueue {
  enqueue(job: DocLensIntakeJob): Promise<void>;
}

interface DocLensWorkerMetrics {
  recordQueueWait(elapsedMs: number): void;
  recordFailure(stage: "parsing" | "classification" | "extraction" | "processing"): void;
  recordRetry(): void;
  setWorkerAvailable(available: boolean): void;
}

/** A PHI-safe, provider-detail-free projection for operational logs. */
export function docLensOperationalSummary(
  summary: DocLensIntakeSummary,
): Record<string, unknown> {
  if (summary.outcome === "skipped" || summary.outcome === "parse_failed") {
    return { outcome: summary.outcome, reason: summary.reason };
  }
  return {
    outcome: summary.outcome,
    pages: summary.pages,
    jobs: summary.jobs,
    candidates: summary.candidates,
    dropped: summary.dropped,
    refusalCount: summary.refusals.length,
    vision: summary.vision,
    sud: { indicators: summary.sud.indicators, pageCount: summary.sud.pages.length },
    identity: summary.identity,
    recordsRequest: summary.recordsRequest,
    documents: summary.documents,
    coding: summary.coding,
  };
}

export function createDocLensIntakeEnqueue(connection: ConnectionOptions): DocLensIntakeEnqueue & {
  close(): Promise<void>;
} {
  const queue = new Queue<DocLensIntakeJob>(M22_DOCLENS_INTAKE_QUEUE, { connection });
  return {
    async enqueue(job) {
      const jobId = `doclens-intake-${job.batchId}`;
      const prior = await queue.getJob(jobId);
      const replacingFailed = prior ? await prior.isFailed() : false;
      if (prior && replacingFailed) await prior.remove();
      const add = () =>
        queue.add("intake", job, {
          jobId,
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: false,
        });
      await add();
      if (!replacingFailed) return;

      // BullMQ can finish the failed-event cleanup just after `remove()`: the first same-id add then
      // returns without leaving a job. Do not acknowledge a retry that does not exist. A real intake
      // cannot complete inside this short verification window (it must at least call Docling), and the
      // deterministic id still collapses concurrent clicks once materialized.
      if (await queue.getJob(jobId)) return;
      for (const delayMs of [25, 50, 100, 200]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (await queue.getJob(jobId)) return;
        await add();
      }
      if (!(await queue.getJob(jobId))) {
        throw new Error("WardenLens retry job did not materialize");
      }
    },
    close: () => queue.close(),
  };
}

export function registerDocLensIntakeWorker(
  connection: ConnectionOptions,
  deps: DocLensIntakeDeps,
  log: (msg: string, detail: Record<string, unknown>) => void,
  onExhausted: (
    job: DocLensIntakeJob,
    failureCode: DocLensTerminalFailureCode,
    attempts: number,
  ) => Promise<void> = (job, failureCode, attempts) =>
    markDocLensIntakeFailed(deps, job, failureCode, attempts),
  metrics?: DocLensWorkerMetrics,
): Worker<DocLensIntakeJob> {
  const worker = new Worker<DocLensIntakeJob>(
    M22_DOCLENS_INTAKE_QUEUE,
    async (job) => {
      metrics?.recordQueueWait(Math.max(0, (job.processedOn ?? Date.now()) - job.timestamp));
      if (job.attemptsMade > 0) metrics?.recordRetry();
      const summary = await runDocLensIntake(deps, job.data);
      // Counts and reasons only — never a value, a quote or a URL.
      log("M22 DocLens intake run", {
        org: job.data.organizationId,
        batch: job.data.batchId,
        correlationId: job.data.correlationId,
        summary: docLensOperationalSummary(summary),
      });
      return summary;
    },
    { connection, concurrency: 1, lockDuration: 15 * 60_000 },
  );
  worker.on("failed", async (failedJob, error) => {
    if (!failedJob || !(await isExhausted(failedJob))) return;
    const failureCode = classifyTerminalFailure(error);
    const configuredAttempts =
      typeof failedJob.opts.attempts === "number" ? failedJob.opts.attempts : 1;
    metrics?.recordFailure(failureCode === "docling_unavailable" ? "parsing" : "processing");
    try {
      await onExhausted(failedJob.data, failureCode, configuredAttempts);
      log("M22 DocLens intake exhausted", {
        org: failedJob.data.organizationId,
        batch: failedJob.data.batchId,
        correlationId: failedJob.data.correlationId,
        failureCode,
        attempts: configuredAttempts,
      });
    } catch {
      log("M22 DocLens intake failure projection failed", {
        org: failedJob.data.organizationId,
        batch: failedJob.data.batchId,
        correlationId: failedJob.data.correlationId,
        failureCode,
        attempts: configuredAttempts,
      });
    }
  });
  metrics?.setWorkerAvailable(true);
  worker.on("closed", () => metrics?.setWorkerAvailable(false));
  return worker;
}

async function isExhausted(
  job: Pick<Job<DocLensIntakeJob>, "attemptsMade" | "opts" | "getState">,
): Promise<boolean> {
  const configured = typeof job.opts.attempts === "number" ? job.opts.attempts : 1;
  if (configured <= 1) return true;
  // BullMQ emits Worker.failed before all retry bookkeeping is consistently observable. After the
  // transition settles, an intermediate attempt is `delayed`/`waiting`; only the exhausted attempt is
  // durably `failed`. `attemptsMade` alone was observed as both N-1 and N at this callback boundary.
  await new Promise((resolve) => setTimeout(resolve, 25));
  return (await job.getState()) === "failed";
}

function classifyTerminalFailure(error: Error): DocLensTerminalFailureCode {
  return error instanceof DoclingParseError && error.kind === "unavailable"
    ? "docling_unavailable"
    : "processing_error";
}
