// apps/backend/src/modules/40-mdm/jobs/cron-workers.ts — the LIVE BullMQ Workers + repeatable Queues for M40's
// scheduled §4.3 jobs (GAP-173; the M39 `jobs/cron-workers.ts` template). Queue names and cadences are the
// `@wardenx/mdm` catalog (`MDM_QUEUES` / `MDM_JOB_SCHEDULES`, single source); the bodies are the sibling files.
// This file is only the BullMQ shell.
//
// The §4.3 table has eight jobs; how each is covered:
//   mdm.nppes_nightly_delta    02:00      ./nppes-fallback.ts   (fallback-only: stands down if M29 synced < 25 h ago)
//   mdm.nppes_weekly_full      Sun 03:00  ./nppes-fallback.ts
//   mdm.fuzzy_dedup_scan       04:00      ./fuzzy-dedup.ts      (writes `merge_request` via the 0473 definer function)
//   mdm.baa_expiration_scan    06:00      ./baa-scan.ts
//   mdm.license_expiration_scan 06:30     ./license-scan.ts
//   mdm.provisional_aging_scan Mon 07:00  ./provisional-aging.ts
//   mdm.execute_merge          (event)    runs INLINE in the approve route: migration 0205's
//                                         `mdm_canonical_writer_approve_merge` flips the duplicate and re-points in one
//                                         transaction (GAP-060), so there is no queue hop to build.
//   mdm.repoint_<consumer>     (event)    the per-consumer re-point is a one-liner each downstream module adds beside its
//                                         own FK column (spec §11 / Lock status) — owned by those modules, not built here.
import type { DbClient } from "@wardenx/db";
import { MDM_JOB_SCHEDULES, MDM_QUEUES } from "@wardenx/mdm";
import type { NppesFreshRecord } from "@wardenx/mdm";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { M40ActiveOrgPort, M40AlertPort } from "../outbox-consumers/nppes-consumer-ports";
import { runBaaExpirationScan } from "./baa-scan";
import { runFuzzyDedupScan } from "./fuzzy-dedup";
import { runLicenseExpirationScan } from "./license-scan";
import { runNppesNightlyDeltaJob, runNppesWeeklyFullJob } from "./nppes-fallback";
import type { PlatformOpsSink } from "./platform-ops";
import { runProvisionalAgingScan } from "./provisional-aging";

/** A failed tick is retried a few times quickly, then waits for the next scheduled one. */
const JOB_ATTEMPTS = 3;
const JOB_BACKOFF_MS = 30_000;

export interface M40WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly alerts: M40AlertPort;
  readonly orgs: M40ActiveOrgPort;
  /** The live platform-ops sink (log + optional webhook); the durable audit write is separate. */
  readonly platformOps: PlatformOpsSink;
  /** One NPI → fresh NPPES record (M29's client, bound at the composition root). */
  readonly fetchProvider: (npi: string) => Promise<NppesFreshRecord | null>;
  /** When M29's platform sync last completed (M29's reader, bound at the composition root). */
  readonly m29LastSyncCompletedAt: () => Promise<Date | null>;
  readonly now?: () => Date;
}

/** Queue name → the body its Worker runs. */
function processors(deps: M40WorkerDeps): ReadonlyArray<readonly [string, () => Promise<unknown>]> {
  const org = { db: deps.db, alerts: deps.alerts, orgs: deps.orgs, now: deps.now };
  const ops = { db: deps.db, sink: deps.platformOps, now: deps.now };
  const nppes = {
    db: deps.db,
    alerts: deps.alerts,
    orgs: deps.orgs,
    fetchProvider: deps.fetchProvider,
    m29LastSyncCompletedAt: deps.m29LastSyncCompletedAt,
    now: deps.now,
  };
  return [
    [MDM_QUEUES.nppesNightlyDelta, () => runNppesNightlyDeltaJob(nppes)],
    [MDM_QUEUES.nppesWeeklyFull, () => runNppesWeeklyFullJob(nppes)],
    [MDM_QUEUES.fuzzyDedupScan, () => runFuzzyDedupScan(ops)],
    [MDM_QUEUES.baaExpirationScan, () => runBaaExpirationScan(org)],
    [MDM_QUEUES.licenseExpirationScan, () => runLicenseExpirationScan(org)],
    [MDM_QUEUES.provisionalAgingScan, () => runProvisionalAgingScan({ ...ops, orgs: deps.orgs })],
  ];
}

/** Construct M40's Workers (the caller owns lifecycle — `close()` on shutdown). */
export function registerM40CronWorkers(deps: M40WorkerDeps): Worker[] {
  return processors(deps).map(
    ([queue, run]) =>
      new Worker(
        queue,
        async () => {
          await run();
        },
        { connection: deps.connection, concurrency: 1 },
      ),
  );
}

/** The (queue, cron pattern) pairs registered as repeatables. */
export const M40_SCHEDULES: ReadonlyArray<readonly [string, string]> = [
  [MDM_QUEUES.nppesNightlyDelta, MDM_JOB_SCHEDULES.nppesNightlyDelta],
  [MDM_QUEUES.nppesWeeklyFull, MDM_JOB_SCHEDULES.nppesWeeklyFull],
  [MDM_QUEUES.fuzzyDedupScan, MDM_JOB_SCHEDULES.fuzzyDedupScan],
  [MDM_QUEUES.baaExpirationScan, MDM_JOB_SCHEDULES.baaExpirationScan],
  [MDM_QUEUES.licenseExpirationScan, MDM_JOB_SCHEDULES.licenseExpirationScan],
  [MDM_QUEUES.provisionalAgingScan, MDM_JOB_SCHEDULES.provisionalAgingScan],
];

/** Register the repeatable schedules. `removeOnFail: false` keeps the failed set as the de facto DLQ (the
 *  M9/M14/M20/M39 convention). Returns the `Queue`s to `close()`. */
export async function scheduleM40Jobs(
  connection: ConnectionOptions,
  opts: { readonly includeNppes?: boolean } = {},
): Promise<Queue[]> {
  const includeNppes = opts.includeNppes ?? true;
  const queues: Queue[] = [];
  for (const [name, pattern] of M40_SCHEDULES) {
    // The two NPPES jobs reach the public CMS registry; `NPPES_SYNC_DISABLED=1` opts a deployment out (the same
    // hatch M29's sync honours) while the Workers stay constructed so an operator can still run one on demand.
    if (
      !includeNppes &&
      (name === MDM_QUEUES.nppesNightlyDelta || name === MDM_QUEUES.nppesWeeklyFull)
    ) {
      continue;
    }
    const queue = new Queue(name, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern },
        attempts: JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: JOB_BACKOFF_MS },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
