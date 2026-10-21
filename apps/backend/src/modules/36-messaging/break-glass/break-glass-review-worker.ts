// apps/backend/src/modules/36-messaging/break-glass/break-glass-review-worker.ts - WP 5.8 (ADR-0087, PROPOSED): the BullMQ shell of the overdue
// escalation (`messaging.break_glass_review_sweep`, hourly). One repeatable tick fans out over the active orgs; each org's overdue open reviews
// raise their alert through the org-explicit `overdueForOrg` (idempotent on the review id). An org-level failure fails the tick through the same
// fan-out the integrity jobs use, so it is visible in the failed set and the DLQ alert. Flag-independent by design: accountability for a grant
// that exists must not stall because the feature was switched off.
import { MESSAGING_JOB_SCHEDULES, MESSAGING_QUEUES } from "@chartwarden/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import type { BreakGlassReviewSweepResult } from "./break-glass-review-sweep";

export interface M36BreakGlassReviewWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly overdueForOrg: (orgId: string) => Promise<BreakGlassReviewSweepResult>;
}

/** One tick: raise the overdue alert for every active org's open reviews past the escalation age. Returns the total (tests and logs). */
export async function breakGlassReviewTick(
  deps: Pick<M36BreakGlassReviewWorkerDeps, "activeOrgs" | "onError" | "overdueForOrg">,
): Promise<BreakGlassReviewSweepResult> {
  const totals = { overdue: 0 };
  await fanOutOrgs(deps, "break_glass_review_sweep", async (organizationId) => {
    totals.overdue += (await deps.overdueForOrg(organizationId)).overdue;
  });
  return totals;
}

export function registerM36BreakGlassReviewWorker(deps: M36BreakGlassReviewWorkerDeps): Worker[] {
  return [
    new Worker(MESSAGING_QUEUES.breakGlassReviewSweep, () => breakGlassReviewTick(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),
  ];
}

/** Register the repeatable trigger. Returns the `Queue`s to `close()`. */
export async function scheduleM36BreakGlassReviewJobs(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(MESSAGING_QUEUES.breakGlassReviewSweep, { connection });
  await queue.add(
    "sweep",
    {},
    { repeat: { pattern: MESSAGING_JOB_SCHEDULES.breakGlassReviewSweep }, removeOnComplete: true },
  );
  return [queue];
}
