// apps/backend/src/modules/22-documents/extraction/intake-queue.ts — the BullMQ queue the DocLens intake
// job runs on (F-236). The route enqueues; the WORKER process runs `runDocLensIntake` (concurrency 1: a
// local model serves one extraction at a time, and a batch's stages are sequential anyway).
//
// One job per batch at a time: the job id is the batch id, so a double-click re-enqueue is collapsed by
// BullMQ while the first is queued or running; the job itself is idempotent on batch status afterwards.
// A job that FAILED (every attempt spent — e.g. the docling-worker was down) is kept for inspection, and
// BullMQ silently ignores `add` for an id it still holds, so a re-run answered 202 "queued" and did nothing
// (F-238 E2E). Enqueue therefore removes a failed job of the same id first.
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type DocLensIntakeDeps, type DocLensIntakeJob, runDocLensIntake } from "./intake-job";

export const M22_DOCLENS_INTAKE_QUEUE = "m22-doclens-intake";

export interface DocLensIntakeEnqueue {
  enqueue(job: DocLensIntakeJob): Promise<void>;
}

export function createDocLensIntakeEnqueue(connection: ConnectionOptions): DocLensIntakeEnqueue & {
  close(): Promise<void>;
} {
  const queue = new Queue<DocLensIntakeJob>(M22_DOCLENS_INTAKE_QUEUE, { connection });
  return {
    async enqueue(job) {
      const jobId = `doclens-intake-${job.batchId}`;
      const prior = await queue.getJob(jobId);
      if (prior && (await prior.isFailed())) await prior.remove();
      await queue.add("intake", job, {
        jobId,
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: false,
      });
    },
    close: () => queue.close(),
  };
}

export function registerDocLensIntakeWorker(
  connection: ConnectionOptions,
  deps: DocLensIntakeDeps,
  log: (msg: string, detail: Record<string, unknown>) => void,
): Worker<DocLensIntakeJob> {
  return new Worker<DocLensIntakeJob>(
    M22_DOCLENS_INTAKE_QUEUE,
    async (job) => {
      const summary = await runDocLensIntake(deps, job.data);
      // Counts and reasons only — never a value, a quote or a URL.
      log("M22 DocLens intake run", {
        org: job.data.organizationId,
        batch: job.data.batchId,
        correlationId: job.data.correlationId,
        summary,
      });
      return summary;
    },
    { connection, concurrency: 1, lockDuration: 15 * 60_000 },
  );
}
