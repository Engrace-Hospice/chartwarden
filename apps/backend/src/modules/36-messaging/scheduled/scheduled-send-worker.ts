// apps/backend/src/modules/36-messaging/scheduled/scheduled-send-worker.ts — WP 2.6: the BullMQ shell that sweeps due
// scheduled messages (`messaging.scheduled_send`, every minute). One repeatable tick fans out over the active orgs; each
// org's due rows are dispatched by the dispatcher (re-check, send, delete in one transaction). A per-row problem is
// absorbed by the dispatcher (counted, then blocked); an org-level failure (e.g. the database) fails the tick via the
// same fan-out the integrity jobs use, so it is visible in the failed set and the DLQ alert.
import { MESSAGING_JOB_SCHEDULES, MESSAGING_QUEUES } from "@wardenx/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import type { DispatchResult, ScheduledSendDispatcher } from "./scheduled-send-dispatcher";

export interface M36ScheduledSendWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly dispatcher: Pick<ScheduledSendDispatcher, "dispatchDueForOrg">;
}

/** One tick: dispatch every active org's due rows. Returns the summed result (tests and logs). */
export async function scheduledSendTick(
  deps: Pick<M36ScheduledSendWorkerDeps, "activeOrgs" | "onError" | "dispatcher">,
): Promise<DispatchResult> {
  const totals = { sent: 0, blocked: 0, failed: 0 };
  await fanOutOrgs(deps, "scheduled_send", async (organizationId) => {
    const result = await deps.dispatcher.dispatchDueForOrg(organizationId);
    totals.sent += result.sent;
    totals.blocked += result.blocked;
    totals.failed += result.failed;
  });
  return totals;
}

export function registerM36ScheduledSendWorker(deps: M36ScheduledSendWorkerDeps): Worker[] {
  return [
    new Worker(MESSAGING_QUEUES.scheduledSend, () => scheduledSendTick(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),
  ];
}

/** Register the repeatable trigger. Returns the `Queue`s to `close()`. */
export async function scheduleM36ScheduledSendJobs(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(MESSAGING_QUEUES.scheduledSend, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: MESSAGING_JOB_SCHEDULES.scheduledSend }, removeOnComplete: true },
  );
  return [queue];
}
