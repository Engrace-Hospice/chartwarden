// apps/backend/src/modules/36-messaging/emergency/emergency-sweep-worker.ts - ADR-0106 B: the BullMQ shell for `messaging.emergency_sweep`
// (every minute). One repeatable tick fans out over the active orgs (the same fan-out the reminder and integrity jobs use); a per-alert
// failure is counted inside the org sweep and fails the tick so it is visible.
import { MESSAGING_JOB_SCHEDULES, MESSAGING_QUEUES } from "@chartwarden/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import type { EmergencySweepSummary } from "./emergency-sweep";

export interface M36EmergencySweepWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly sweep: (orgId: string) => Promise<EmergencySweepSummary>;
}

async function emergencySweepTick(
  deps: Pick<M36EmergencySweepWorkerDeps, "activeOrgs" | "onError" | "sweep">,
): Promise<EmergencySweepSummary> {
  const totals = { alarms: 0, escalations: 0, failed: 0 };
  await fanOutOrgs(deps, "emergency_sweep", async (organizationId) => {
    const result = await deps.sweep(organizationId);
    totals.alarms += result.alarms;
    totals.escalations += result.escalations;
    totals.failed += result.failed;
    if (result.failed > 0)
      throw new Error(`emergency sweep: ${result.failed} alert(s) failed to raise`);
  });
  return totals;
}

export function registerM36EmergencySweepWorker(deps: M36EmergencySweepWorkerDeps): Worker[] {
  return [
    new Worker(MESSAGING_QUEUES.emergencySweep, () => emergencySweepTick(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),
  ];
}

/** Register the repeatable trigger. Returns the `Queue`s to `close()`. */
export async function scheduleM36EmergencySweepJobs(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(MESSAGING_QUEUES.emergencySweep, { connection });
  await queue.add(
    "sweep",
    {},
    { repeat: { pattern: MESSAGING_JOB_SCHEDULES.emergencySweep }, removeOnComplete: true },
  );
  return [queue];
}
