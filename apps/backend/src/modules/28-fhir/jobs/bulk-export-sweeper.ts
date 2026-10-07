import type { DbClient } from "@wardenx/db";
// apps/backend/src/modules/28-fhir/jobs/bulk-export-sweeper.ts — the `fhir.bulk-export-sweeper` cron (GAP-084,
// §2.2, §4.8). Every 15 minutes, per org, bounded to {@link SWEEP_BATCH_LIMIT} jobs per category per tick:
//
//   1. EXPIRY — a `completed` job past `expires_at` has every NDJSON object destroyed and then moves to
//      `expired`. The order matters: the status flips only AFTER every object is gone (§8.4 "return success
//      only after MinIO purge succeeds"), so a failed destroy leaves the job `completed` and the next tick
//      retries it. An already-`expired` job that still holds a live artifact (the M4 offboarding eraser flips
//      jobs to `expired` without touching MinIO) is purged the same way.
//   2. ORPHANS — a job stuck `accepted` past {@link ORPHAN_ACCEPTED_AFTER_MS} lost its producer enqueue
//      (Valkey blip between the commit and the `add`); it is re-enqueued. The BullMQ job id is deterministic
//      per job, so a re-enqueue of a job that IS queued is a no-op, and the worker's claim makes a duplicate
//      delivery harmless anyway.
//   2b. ABANDONED — a job `accepted` for more than a day was never run (pre-GAP-084 rows, or a request too stale
//      to honour); it is CANCELLED rather than run, which also releases the client's one-active-job slot.
//   3. STALLED — a job `in_progress` past {@link STALLED_IN_PROGRESS_AFTER_MS} belonged to a worker that died;
//      it is failed (the FSM has no way back to `accepted`) so the client's one-active-job slot is released.
//
// One org's failure must not stop the others: failures are collected per org and re-thrown as one
// AggregateError after every org was swept, so the job still fails loudly (retry / DLQ).
import { bulkExportCancelledEvent, bulkExportFailedEvent } from "@wardenx/fhir";
import type { FhirBulkExportJobId, FhirClientId } from "@wardenx/types";

import {
  type ExportOutboxEvent,
  abandonedAcceptedJobs,
  cancelAbandonedJob,
  dueExpiredJobIds,
  expiredJobIdsWithLiveArtifacts,
  failExportJob,
  listJobArtifacts,
  markArtifactPurged,
  markJobExpired,
  orphanedAcceptedJobIds,
  stalledInProgressJobs,
} from "./export-store";
import type {
  ActiveOrgListPort,
  BulkExportEnqueuePort,
  FhirExportObjectStore,
  FhirJobOutboxPort,
} from "./ports";
import {
  ABANDON_ACCEPTED_AFTER_MS,
  ORPHAN_ACCEPTED_AFTER_MS,
  STALLED_IN_PROGRESS_AFTER_MS,
  SWEEP_BATCH_LIMIT,
} from "./queues";

export interface BulkExportSweeperDeps {
  readonly db: DbClient;
  readonly outbox: FhirJobOutboxPort;
  readonly objects: FhirExportObjectStore;
  readonly enqueue: BulkExportEnqueuePort;
  readonly activeOrgs: ActiveOrgListPort;
  readonly now?: () => Date;
  readonly log?: { error(obj: unknown, msg?: string): void };
}

export interface BulkExportSweepResult {
  readonly expired: number;
  readonly requeued: number;
  readonly stalledFailed: number;
  readonly abandonedCancelled: number;
}

const publishFor =
  (deps: BulkExportSweeperDeps, organizationId: string, jobId: string) =>
  async (tx: DbClient, event: ExportOutboxEvent): Promise<void> => {
    await deps.outbox.publish(tx, {
      eventName: event.eventName,
      payload: event.payload,
      organizationId,
      aggregateKind: "fhir_bulk_export_job",
      aggregateId: jobId,
    });
  };

const STALLED_REASON = "the export worker stopped before the job finished";

/** Destroy every live object of one job, then flip it `expired`. Throws if any destroy failed. */
async function purgeJob(
  deps: BulkExportSweeperDeps,
  organizationId: string,
  jobId: string,
): Promise<boolean> {
  const artifacts = await listJobArtifacts(deps.db, organizationId, jobId);
  for (const artifact of artifacts) {
    if (artifact.objectKey === "") continue;
    await deps.objects.destroy({ organizationId, objectKey: artifact.objectKey });
    await markArtifactPurged(deps.db, organizationId, jobId, artifact.objectKey);
  }
  return markJobExpired(deps.db, organizationId, jobId);
}

async function sweepExpiry(
  deps: BulkExportSweeperDeps,
  organizationId: string,
  now: Date,
  failures: unknown[],
): Promise<number> {
  const due = await dueExpiredJobIds(deps.db, organizationId, now, SWEEP_BATCH_LIMIT);
  const leftovers = await expiredJobIdsWithLiveArtifacts(
    deps.db,
    organizationId,
    SWEEP_BATCH_LIMIT,
  );
  let expired = 0;
  for (const jobId of new Set([...due, ...leftovers])) {
    try {
      if (await purgeJob(deps, organizationId, jobId)) expired += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  return expired;
}

async function sweepOrphans(
  deps: BulkExportSweeperDeps,
  organizationId: string,
  now: Date,
  failures: unknown[],
): Promise<number> {
  const window = {
    olderThan: new Date(now.getTime() - ORPHAN_ACCEPTED_AFTER_MS),
    newerThan: new Date(now.getTime() - ABANDON_ACCEPTED_AFTER_MS),
  };
  const ids = await orphanedAcceptedJobIds(deps.db, organizationId, window, SWEEP_BATCH_LIMIT);
  let requeued = 0;
  for (const jobId of ids) {
    try {
      await deps.enqueue.enqueue(organizationId, jobId);
      requeued += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  return requeued;
}

async function sweepAbandoned(
  deps: BulkExportSweeperDeps,
  organizationId: string,
  now: Date,
  failures: unknown[],
): Promise<number> {
  const olderThan = new Date(now.getTime() - ABANDON_ACCEPTED_AFTER_MS);
  const abandoned = await abandonedAcceptedJobs(
    deps.db,
    organizationId,
    olderThan,
    SWEEP_BATCH_LIMIT,
  );
  let cancelled = 0;
  for (const job of abandoned) {
    try {
      const event = bulkExportCancelledEvent({
        jobId: job.id as FhirBulkExportJobId,
        clientId: job.clientId as FhirClientId,
        cancelledByMembershipId: null,
        cancelledAt: now.toISOString(),
      });
      const done = await cancelAbandonedJob(
        deps.db,
        organizationId,
        job.id,
        { eventName: event.type, payload: event.payload },
        publishFor(deps, organizationId, job.id),
      );
      if (done) cancelled += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  return cancelled;
}

async function sweepStalled(
  deps: BulkExportSweeperDeps,
  organizationId: string,
  now: Date,
  failures: unknown[],
): Promise<number> {
  const startedBefore = new Date(now.getTime() - STALLED_IN_PROGRESS_AFTER_MS);
  const stalled = await stalledInProgressJobs(
    deps.db,
    organizationId,
    startedBefore,
    SWEEP_BATCH_LIMIT,
  );
  let failed = 0;
  for (const job of stalled) {
    try {
      const event = bulkExportFailedEvent({
        jobId: job.id as FhirBulkExportJobId,
        clientId: job.clientId as FhirClientId,
        failedAt: now.toISOString(),
        failureReason: STALLED_REASON,
      });
      const payload: ExportOutboxEvent = { eventName: event.type, payload: event.payload };
      const done = await failExportJob(
        deps.db,
        organizationId,
        job.id,
        STALLED_REASON,
        payload,
        publishFor(deps, organizationId, job.id),
      );
      if (done) failed += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  return failed;
}

/** One sweeper tick across every active org. */
export async function runBulkExportSweeper(
  deps: BulkExportSweeperDeps,
): Promise<BulkExportSweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  const failures: unknown[] = [];
  let expired = 0;
  let requeued = 0;
  let stalledFailed = 0;
  let abandonedCancelled = 0;
  for (const { organizationId } of orgs) {
    try {
      abandonedCancelled += await sweepAbandoned(deps, organizationId, now, failures);
      expired += await sweepExpiry(deps, organizationId, now, failures);
      requeued += await sweepOrphans(deps, organizationId, now, failures);
      stalledFailed += await sweepStalled(deps, organizationId, now, failures);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    deps.log?.error({ failures: failures.length }, "m28 bulk-export sweeper: some work failed");
    throw new AggregateError(failures, `fhir.bulk-export-sweeper: ${failures.length} failure(s)`);
  }
  return { expired, requeued, stalledFailed, abandonedCancelled };
}
