// apps/backend/src/modules/28-fhir/jobs/workers.ts — BullMQ registration for the M28 §4.8 workers (GAP-084):
// the processors, the repeatable schedules, and the producer that the `$export` routes call after commit.
//
// Queue names and job ids contain no ':' (BullMQ forbids it in a custom id). The bulk-export job id is
// deterministic per `fhir_bulk_export_job` row, so a re-enqueue by the sweeper cannot double-queue it.
import { type ConnectionOptions, Queue, Worker } from "bullmq";

import { type BulkExportSweeperDeps, runBulkExportSweeper } from "./bulk-export-sweeper";
import { type BulkExportWorkerDeps, runBulkExportJob } from "./bulk-export-worker";
import { type CapabilitySnapshotDeps, runCapabilitySnapshotValidator } from "./capability-snapshot";
import {
  type InboundWorkerDeps,
  runInboundPayloadDestruction,
  runInboundSlaWatch,
} from "./inbound-workers";
import type { BulkExportEnqueuePort } from "./ports";
import { M28_JOB_SCHEDULES, M28_QUEUES } from "./queues";
import { type SessionSweeperDeps, runClientSessionSweeper } from "./session-sweeper";

/** §4.8: 4 export jobs per backend node. The per-client limit is the 429 at submission + the DB claim. */
const BULK_EXPORT_CONCURRENCY = 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface M28WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly bulkExport: BulkExportWorkerDeps;
  readonly sweeper: BulkExportSweeperDeps;
  readonly inbound: InboundWorkerDeps;
  readonly sessions: SessionSweeperDeps;
  readonly capability: CapabilitySnapshotDeps;
}

export interface BulkExportJobData {
  readonly organizationId: string;
  readonly jobId: string;
}

/** A malformed payload throws (the job fails loudly) rather than running against an unintended tenant. */
export function parseBulkExportJobData(data: unknown): BulkExportJobData {
  const d = data as { organizationId?: unknown; jobId?: unknown } | null;
  if (
    typeof d?.organizationId !== "string" ||
    typeof d.jobId !== "string" ||
    !UUID_RE.test(d.organizationId) ||
    !UUID_RE.test(d.jobId)
  ) {
    throw new Error("fhir.bulk-export: job data must carry a uuid organizationId and jobId");
  }
  return { organizationId: d.organizationId, jobId: d.jobId };
}

/** Construct the live M28 workers. */
export function registerM28Workers(deps: M28WorkerDeps): Worker[] {
  const cron = { connection: deps.connection, concurrency: 1 } as const;
  return [
    new Worker(
      M28_QUEUES.bulkExport,
      async (job) => runBulkExportJob(deps.bulkExport, parseBulkExportJobData(job.data)),
      { connection: deps.connection, concurrency: BULK_EXPORT_CONCURRENCY },
    ),
    new Worker(M28_QUEUES.bulkExportSweeper, async () => runBulkExportSweeper(deps.sweeper), cron),
    new Worker(M28_QUEUES.inboundSlaWatch, async () => runInboundSlaWatch(deps.inbound), cron),
    new Worker(
      M28_QUEUES.inboundPayloadDestruction,
      async () => runInboundPayloadDestruction(deps.inbound),
      cron,
    ),
    new Worker(
      M28_QUEUES.clientSessionSweeper,
      async () => runClientSessionSweeper(deps.sessions),
      cron,
    ),
    new Worker(
      M28_QUEUES.capabilitySnapshotValidator,
      async () => runCapabilitySnapshotValidator(deps.capability),
      cron,
    ),
  ];
}

/** Register the repeatable schedules (3 retries, exponential backoff). Returns the queues to close. */
export async function scheduleM28Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules = [
    { name: M28_QUEUES.bulkExportSweeper, pattern: M28_JOB_SCHEDULES.bulkExportSweeper },
    { name: M28_QUEUES.inboundSlaWatch, pattern: M28_JOB_SCHEDULES.inboundSlaWatch },
    {
      name: M28_QUEUES.inboundPayloadDestruction,
      pattern: M28_JOB_SCHEDULES.inboundPayloadDestruction,
    },
    { name: M28_QUEUES.clientSessionSweeper, pattern: M28_JOB_SCHEDULES.clientSessionSweeper },
    {
      name: M28_QUEUES.capabilitySnapshotValidator,
      pattern: M28_JOB_SCHEDULES.capabilitySnapshotValidator,
    },
  ] as const;
  const queues: Queue[] = [];
  for (const schedule of schedules) {
    const queue = new Queue(schedule.name, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern: schedule.pattern },
        attempts: 3,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    queues.push(queue);
  }
  return queues;
}

/** The producer the `$export` routes call after their transaction commits. */
export function buildBulkExportEnqueuePort(connection: ConnectionOptions): {
  readonly port: BulkExportEnqueuePort;
  readonly queue: Queue;
} {
  const queue = new Queue(M28_QUEUES.bulkExport, { connection });
  return {
    queue,
    port: {
      async enqueue(organizationId, jobId) {
        await queue.add("export", { organizationId, jobId } satisfies BulkExportJobData, {
          // Deterministic: the sweeper's re-enqueue of an already-queued job is a no-op.
          jobId: `fhir-export-${jobId}`,
          // The worker owns its own failure path (it marks the job `failed` and returns), so a thrown
          // error here means the claim itself could not run (DB blip) while the row is still `accepted`:
          // retry that. A retry after a mid-run crash finds the job `in_progress`, skips, and the
          // sweeper fails it.
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: true,
          removeOnFail: 100,
        });
      },
    },
  };
}
