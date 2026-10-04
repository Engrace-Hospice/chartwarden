// apps/backend/src/modules/05-patient/jobs/snapshot-rebuild-worker.ts — the BullMQ shell of the quarterly
// `patient.snapshot_rebuild` (M5 §4.5; the per-org body is `./snapshot-rebuild.ts`).
//
// The same thin per-org fan-out as M22's records-request expiry and M11's verbal-order expiry: one repeatable
// trigger enumerates active orgs under the audited platform context (the composition root binds
// `buildActiveOrgEnumerator` under M5_SNAPSHOT_REBUILD_PLATFORM_JOB_ID), then each org runs
// `rebuildPrivacySnapshotsForOrg` org-explicitly (a cron tick is not a request). One org's failure never
// skips the others; all failures are re-raised together so BullMQ retries (the rebuild is idempotent).
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import { M5_JOB_SCHEDULES, M5_QUEUES } from "./index";
import type { SnapshotRebuildSummary } from "./snapshot-rebuild";

/** §4.5 queue `patient.snapshot_rebuild` (M5's queue-name convention prefixes the module: `m5.`). */
export const M5_SNAPSHOT_REBUILD_QUEUE = M5_QUEUES.snapshotRebuild;
/** Quarterly (§4.5 / D3 give no time): 03:00 on the 1st of January, April, July and October. */
export const M5_SNAPSHOT_REBUILD_SCHEDULE = M5_JOB_SCHEDULES.snapshotRebuild;
/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M5_SNAPSHOT_REBUILD_PLATFORM_JOB_ID = "m5.snapshot_rebuild";

export interface SnapshotRebuildWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  /** `rebuildPrivacySnapshotsForOrg` bound to the tenant pool, the m5 outbox and the M39/M22 ports. */
  readonly rebuildForOrg: (organizationId: string) => Promise<SnapshotRebuildSummary>;
  readonly log?: (msg: string, detail: Record<string, unknown>) => void;
}

/** The run's totals across orgs (counts only). */
export interface SnapshotRebuildRunSummary {
  readonly orgs: number;
  readonly patients: number;
  readonly rewritten: number;
  readonly flagsChanged: number;
  readonly staleCleared: number;
  readonly failedOrgs: number;
}

export async function runSnapshotRebuildFanout(
  deps: Omit<SnapshotRebuildWorkerDeps, "connection">,
): Promise<SnapshotRebuildRunSummary> {
  const failures: unknown[] = [];
  let orgs = 0;
  let patients = 0;
  let rewritten = 0;
  let flagsChanged = 0;
  let staleCleared = 0;
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    orgs++;
    try {
      const s = await deps.rebuildForOrg(organizationId);
      patients += s.patients;
      rewritten += s.rewritten;
      flagsChanged += s.flagsChanged;
      staleCleared += s.staleCleared;
      deps.log?.("m5.privacy_snapshot.rebuilt", { ...s });
    } catch (error) {
      const summary = (error as { summary?: SnapshotRebuildSummary }).summary;
      deps.log?.(
        "m5.privacy_snapshot.rebuild_failed",
        summary ? { ...summary } : { organizationId },
      );
      failures.push(error);
    }
  }
  const run = {
    orgs,
    patients,
    rewritten,
    flagsChanged,
    staleCleared,
    failedOrgs: failures.length,
  };
  deps.log?.("m5.privacy_snapshot.rebuild_run", { ...run });
  if (failures.length)
    throw new AggregateError(failures, `M5_SNAPSHOT_REBUILD: ${failures.length} org failure(s)`);
  return run;
}

export function registerSnapshotRebuildWorker(deps: SnapshotRebuildWorkerDeps): Worker {
  return new Worker(M5_SNAPSHOT_REBUILD_QUEUE, async () => runSnapshotRebuildFanout(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

export async function scheduleSnapshotRebuild(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M5_SNAPSHOT_REBUILD_QUEUE, { connection });
  await queue.add(
    "quarterly",
    {},
    {
      repeat: { pattern: M5_SNAPSHOT_REBUILD_SCHEDULE },
      jobId: "m5-snapshot-rebuild-quarterly",
      attempts: 3,
      backoff: { type: "exponential", delay: 300_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
