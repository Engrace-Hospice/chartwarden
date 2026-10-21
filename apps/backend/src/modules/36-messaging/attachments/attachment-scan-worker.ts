// apps/backend/src/modules/36-messaging/attachments/attachment-scan-worker.ts — WP 1.5: the BullMQ shell that sweeps
// completed-but-unscanned attachments (`messaging.attachment_scan`, every minute). `complete` already tries one scan
// inline; this is the retry path for a scanner that was down, so a pending attachment is never stranded.
//
// A scanner outage is NOT a job failure: the row stays `pending` and the next tick tries again (the per-row error goes
// to `onScanError`). Only an org-level failure (e.g. the DB) fails the tick, via the same fan-out the integrity jobs use.
import { MESSAGING_JOB_SCHEDULES, MESSAGING_QUEUES } from "@chartwarden/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import { REAP_TICK_BUDGET_MS, SCAN_TICK_BUDGET_MS } from "./attachment-policy";
import { fairShareMs, rotateOrgs } from "./attachment-scan-gate";
import type { AttachmentService, ReapRunResult, ScanRunResult } from "./attachment-service-db";

export interface M36AttachmentScanWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly service: Pick<AttachmentService, "scanPendingForOrg" | "reapOrphansForOrg">;
  /** Epoch ms clock (tests). Default Date.now. */
  readonly nowMs?: () => number;
  /** Wall-clock budget of the scan phase, shared fairly across orgs. Default SCAN_TICK_BUDGET_MS. */
  readonly budgetMs?: number;
  /** Wall-clock budget of the reap phase (its own, independent of the scan phase). Default REAP_TICK_BUDGET_MS. */
  readonly reapBudgetMs?: number;
}

/**
 * One tick, two phases with SEPARATE budgets so neither can starve the other: (1) scan every active org's due pending
 * uploads within `budgetMs`, (2) reap abandoned uploads within `reapBudgetMs` (a sibling step of the same schedule, so it
 * needs no queue of its own). Phase 2 runs even when phase 1 throws. Returns the summed result (for tests and logs).
 *
 * Fairness is deterministic and shares no state between orgs: in each phase an org's slice is the budget still unspent
 * divided by the orgs still to go (`fairShareMs`), so an org that finishes early passes its time on and a slow or failing
 * org is cut off at its share, leaving every later org its own. Each org with due work always gets its first scan
 * (reap) started while the phase budget lasts; rotation of the starting org only decides who is cut when there are more
 * orgs than time. Each org's own failures are capped inside `scanPendingForOrg`; every scan and destroy is deadline-bound
 * and aborted at its deadline, so a phase ends within its budget plus one such call.
 */
export async function attachmentScanTick(
  deps: Pick<
    M36AttachmentScanWorkerDeps,
    "activeOrgs" | "onError" | "service" | "nowMs" | "budgetMs" | "reapBudgetMs"
  >,
): Promise<ScanRunResult & { readonly reap: ReapRunResult }> {
  const nowMs = deps.nowMs ?? Date.now;
  const startedAt = nowMs();
  const totals = {
    clean: 0,
    quarantined: 0,
    deferred: 0,
    scannerFailures: 0,
    storeFailures: 0,
    scanUnavailable: 0,
  };
  const reapTotals = { reaped: 0, failed: 0, skippedLegalHold: 0 };
  const phase = (
    budgetMs: number,
    job: string,
    perOrg: (orgId: string, sliceMs: number) => Promise<void>,
  ) => {
    const phaseStart = nowMs();
    let orgsLeft = 0;
    const rotating = {
      listActiveOrgs: async () => {
        const orgs = rotateOrgs(await deps.activeOrgs.listActiveOrgs(), startedAt);
        orgsLeft = orgs.length;
        return orgs;
      },
    };
    return fanOutOrgs({ ...deps, activeOrgs: rotating }, job, async (organizationId) => {
      const slice = fairShareMs(budgetMs - (nowMs() - phaseStart), orgsLeft);
      orgsLeft -= 1;
      await perOrg(organizationId, slice);
    });
  };
  const failures: unknown[] = [];
  try {
    await phase(
      deps.budgetMs ?? SCAN_TICK_BUDGET_MS,
      "attachment_scan",
      async (organizationId, sliceMs) => {
        const result = await deps.service.scanPendingForOrg(organizationId, { budgetMs: sliceMs });
        totals.clean += result.clean;
        totals.quarantined += result.quarantined;
        totals.deferred += result.deferred;
        totals.scannerFailures += result.scannerFailures;
        totals.storeFailures += result.storeFailures;
        totals.scanUnavailable += result.scanUnavailable;
      },
    );
  } catch (error) {
    failures.push(error); // the reap phase still runs; both failures are reported below
  }
  try {
    await phase(
      deps.reapBudgetMs ?? REAP_TICK_BUDGET_MS,
      "attachment_reap",
      async (organizationId, sliceMs) => {
        const reap = await deps.service.reapOrphansForOrg(organizationId, { budgetMs: sliceMs });
        reapTotals.reaped += reap.reaped;
        reapTotals.failed += reap.failed;
        reapTotals.skippedLegalHold += reap.skippedLegalHold;
      },
    );
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "M36 attachment tick failed in both phases");
  }
  return { ...totals, reap: reapTotals };
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
