// apps/backend/src/modules/40-mdm/jobs/cron-workers.ts — the LIVE BullMQ Worker + repeatable Queue for M40's
// §4.3 `mdm.baa_expiration_scan` (GAP-173; the M39 `jobs/cron-workers.ts` template). The queue name and the
// cadence are the `@wardenx/mdm` catalog (`MDM_QUEUES` / `MDM_JOB_SCHEDULES`, single source); the body is
// `./baa-scan.ts`. This file is only the BullMQ shell.
import { MDM_JOB_SCHEDULES, MDM_QUEUES } from "@wardenx/mdm";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type BaaScanDeps, runBaaExpirationScan } from "./baa-scan";

/** A failed daily tick is retried a few times quickly, then waits for tomorrow's. */
const BAA_SCAN_ATTEMPTS = 3;
const BAA_SCAN_BACKOFF_MS = 30_000;

export interface M40WorkerDeps extends BaaScanDeps {
  readonly connection: ConnectionOptions;
}

/** Construct M40's Workers (the caller owns lifecycle — `close()` on shutdown). */
export function registerM40CronWorkers(deps: M40WorkerDeps): Worker[] {
  return [
    new Worker(
      MDM_QUEUES.baaExpirationScan,
      async () => {
        await runBaaExpirationScan(deps);
      },
      { connection: deps.connection, concurrency: 1 },
    ),
  ];
}

/** Register the repeatable daily schedule. `removeOnFail: false` keeps the failed set as the de facto DLQ
 *  (the M9/M14/M20/M39 convention). Returns the `Queue`s to `close()`. */
export async function scheduleM40Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue(MDM_QUEUES.baaExpirationScan, { connection });
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: MDM_JOB_SCHEDULES.baaExpirationScan },
      attempts: BAA_SCAN_ATTEMPTS,
      backoff: { type: "exponential", delay: BAA_SCAN_BACKOFF_MS },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return [queue];
}
