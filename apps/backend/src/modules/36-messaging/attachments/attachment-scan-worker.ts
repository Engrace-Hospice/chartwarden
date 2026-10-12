// apps/backend/src/modules/36-messaging/attachments/attachment-scan-worker.ts — WP 1.5: the BullMQ shell that sweeps
// completed-but-unscanned attachments (`messaging.attachment_scan`, every minute). `complete` already tries one scan
// inline; this is the retry path for a scanner that was down, so a pending attachment is never stranded.
//
// A scanner outage is NOT a job failure: the row stays `pending` and the next tick tries again (the per-row error goes
// to `onScanError`). Only an org-level failure (e.g. the DB) fails the tick, via the same fan-out the integrity jobs use.
import { MESSAGING_JOB_SCHEDULES, MESSAGING_QUEUES } from "@wardenx/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import { SCAN_TICK_BUDGET_MS } from "./attachment-policy";
import { rotateOrgs } from "./attachment-scan-gate";
import type { AttachmentService, ReapRunResult, ScanRunResult } from "./attachment-service-db";

export interface M36AttachmentScanWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly service: Pick<AttachmentService, "scanPendingForOrg" | "reapOrphansForOrg">;
  /** Epoch ms clock (tests). Default Date.now. */
  readonly nowMs?: () => number;
  /** Wall-clock budget after which the tick stops starting scans. Default SCAN_TICK_BUDGET_MS. */
  readonly budgetMs?: number;
}

/**
 * One tick: scan every active org's pending uploads, then reap its abandoned ones (the reap is a sibling step of the
 * same schedule, so it needs no queue of its own). Returns the summed result (for tests and logs).
 *
 * Fairness, with no shared state between orgs: the starting org ROTATES every tick (`rotateOrgs`), and the whole tick has
 * a wall-clock budget after which no new scan is started (the cron period is 60 s; each scan is itself deadline-bound, so
 * the tick ends inside the period). Each org's own failures are capped inside `scanPendingForOrg`. An org the budget did
 * not reach is reached on a later tick; a hostile or broken tenant can slow the sweep, never exclude another from it.
 */
export async function attachmentScanTick(
  deps: Pick<
    M36AttachmentScanWorkerDeps,
    "activeOrgs" | "onError" | "service" | "nowMs" | "budgetMs"
  >,
): Promise<ScanRunResult & { readonly reap: ReapRunResult }> {
  const nowMs = deps.nowMs ?? Date.now;
  const startedAt = nowMs();
  const deadlineMs = startedAt + (deps.budgetMs ?? SCAN_TICK_BUDGET_MS);
  const rotating = {
    listActiveOrgs: async () => rotateOrgs(await deps.activeOrgs.listActiveOrgs(), startedAt),
  };
  let clean = 0;
  let quarantined = 0;
  let deferred = 0;
  let scannerFailures = 0;
  let storeFailures = 0;
  let reaped = 0;
  let failed = 0;
  await fanOutOrgs({ ...deps, activeOrgs: rotating }, "attachment_scan", async (organizationId) => {
    // The reap is independent of the scan: a scan failure for this org must not also skip its reap (nor starve it forever).
    try {
      const result = await deps.service.scanPendingForOrg(organizationId, {
        budgetMs: Math.max(0, deadlineMs - nowMs()),
      });
      clean += result.clean;
      quarantined += result.quarantined;
      deferred += result.deferred;
      scannerFailures += result.scannerFailures;
      storeFailures += result.storeFailures;
    } finally {
      const reap = await deps.service.reapOrphansForOrg(organizationId);
      reaped += reap.reaped;
      failed += reap.failed;
    }
  });
  return { clean, quarantined, deferred, scannerFailures, storeFailures, reap: { reaped, failed } };
}

export function registerM36AttachmentScanWorker(deps: M36AttachmentScanWorkerDeps): Worker[] {
  return [
    new Worker(MESSAGING_QUEUES.attachmentScan, () => attachmentScanTick(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),
  ];
}

/** Register the repeatable trigger. Returns the `Queue`s to `close()`. */
export async function scheduleM36AttachmentScanJobs(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(MESSAGING_QUEUES.attachmentScan, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: MESSAGING_JOB_SCHEDULES.attachmentScan }, removeOnComplete: true },
  );
  return [queue];
}
