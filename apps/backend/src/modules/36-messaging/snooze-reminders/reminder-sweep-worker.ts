// apps/backend/src/modules/36-messaging/snooze-reminders/reminder-sweep-worker.ts - WP 4.10 (ADR-0077): the BullMQ shell for
// `messaging.reminder_sweep` (every minute). One repeatable tick fans out over the active orgs (the same fan-out the integrity and
// handoff-expiry jobs use); a per-row failure is counted inside the org sweep and fails the tick so it is visible.
import { MESSAGING_JOB_SCHEDULES, MESSAGING_QUEUES } from "@chartwarden/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import type { ReminderSweepSummary } from "./reminder-sweep";

export interface M36ReminderSweepWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly sweep: (orgId: string) => Promise<ReminderSweepSummary>;
}

export async function reminderSweepTick(
  deps: Pick<M36ReminderSweepWorkerDeps, "activeOrgs" | "onError" | "sweep">,
): Promise<ReminderSweepSummary> {
  const totals = { raised: 0, dropped: 0, failed: 0 };
  await fanOutOrgs(deps, "reminder_sweep", async (organizationId) => {
    const result = await deps.sweep(organizationId);
    totals.raised += result.raised;
    totals.dropped += result.dropped;
    totals.failed += result.failed;
    if (result.failed > 0) throw new Error(`reminder sweep: ${result.failed} reminder(s) failed`);
  });
  return totals;
}

export function registerM36ReminderSweepWorker(deps: M36ReminderSweepWorkerDeps): Worker[] {
  return [
    new Worker(MESSAGING_QUEUES.reminderSweep, () => reminderSweepTick(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),
  ];
}

/** Register the repeatable trigger. Returns the `Queue`s to `close()`. */
export async function scheduleM36ReminderSweepJobs(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(MESSAGING_QUEUES.reminderSweep, { connection });
  await queue.add(
    "sweep",
    {},
    { repeat: { pattern: MESSAGING_JOB_SCHEDULES.reminderSweep }, removeOnComplete: true },
  );
  return [queue];
}
