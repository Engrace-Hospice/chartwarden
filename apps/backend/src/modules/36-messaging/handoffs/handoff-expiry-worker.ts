// apps/backend/src/modules/36-messaging/handoffs/handoff-expiry-worker.ts - WP 3.5: the BullMQ shell that closes handoff
// offers past their deadline (`messaging.handoff_expiry`, every minute). One repeatable tick fans out over the active orgs;
// each org's due handoffs are closed by the org-explicit `expireDue` (own transaction and row lock per handoff). A
// per-handoff problem is isolated and counted inside it; an org-level failure fails the tick through the same fan-out
// the integrity jobs use, so it is visible in the failed set and the DLQ alert. Flag-independent by design.
import { MESSAGING_JOB_SCHEDULES, MESSAGING_QUEUES } from "@wardenx/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import type { ExpirySummary } from "./handoff-expiry";

export interface M36HandoffExpiryWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly expireDue: (orgId: string) => Promise<ExpirySummary>;
}

/** One tick: close every active org's due handoffs. Returns the summed result (tests and logs). */
export async function handoffExpiryTick(
  deps: Pick<M36HandoffExpiryWorkerDeps, "activeOrgs" | "onError" | "expireDue">,
): Promise<ExpirySummary> {
  const totals = { expired: 0, failed: 0 };
  await fanOutOrgs(deps, "handoff_expiry", async (organizationId) => {
    const result = await deps.expireDue(organizationId);
    totals.expired += result.expired;
    totals.failed += result.failed;
  });
  return totals;
}

export function registerM36HandoffExpiryWorker(deps: M36HandoffExpiryWorkerDeps): Worker[] {
  return [
    new Worker(MESSAGING_QUEUES.handoffExpiry, () => handoffExpiryTick(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),
  ];
}

/** Register the repeatable trigger. Returns the `Queue`s to `close()`. */
export async function scheduleM36HandoffExpiryJobs(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(MESSAGING_QUEUES.handoffExpiry, { connection });
  await queue.add(
    "expire",
    {},
    { repeat: { pattern: MESSAGING_JOB_SCHEDULES.handoffExpiry }, removeOnComplete: true },
  );
  return [queue];
}
