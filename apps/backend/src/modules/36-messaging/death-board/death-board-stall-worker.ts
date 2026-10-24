// apps/backend/src/modules/36-messaging/death-board/death-board-stall-worker.ts - WP 6.9 (ADR-0098 D13): the BullMQ shell of the stall sweep
// (`messaging.death_board_stall_sweep`, hourly). One repeatable tick fans out over the active orgs; each org's open items whose owner lost
// eligibility are flagged through the org-explicit `flagStalledForOrg` (a tick is not a request). An org-level failure fails the tick through the
// same fan-out the integrity jobs use, so it is visible in the failed set and the DLQ alert. Flag-independent: a board that exists must not stall.
import { MESSAGING_JOB_SCHEDULES, MESSAGING_QUEUES } from "@chartwarden/messaging";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import type { StallSummary } from "./death-board-service";

export interface M36DeathBoardStallWorkerDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly flagStalledForOrg: (orgId: string) => Promise<StallSummary>;
}

/** One tick over every active org. Returns the summed result (tests and logs). */
export async function deathBoardStallTick(
  deps: Pick<M36DeathBoardStallWorkerDeps, "activeOrgs" | "onError" | "flagStalledForOrg">,
): Promise<StallSummary> {
  const totals = { examined: 0, flagged: 0 };
  await fanOutOrgs(deps, "death_board_stall_sweep", async (organizationId) => {
    const out = await deps.flagStalledForOrg(organizationId);
    totals.examined += out.examined;
    totals.flagged += out.flagged;
  });
  return totals;
}

export function registerM36DeathBoardStallWorker(deps: M36DeathBoardStallWorkerDeps): Worker[] {
  return [
    new Worker(MESSAGING_QUEUES.deathBoardStallSweep, () => deathBoardStallTick(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),
  ];
}

/** Register the repeatable trigger. Returns the `Queue`s to `close()`. */
export async function scheduleM36DeathBoardStallJobs(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(MESSAGING_QUEUES.deathBoardStallSweep, { connection });
  await queue.add(
    "sweep",
    {},
    { repeat: { pattern: MESSAGING_JOB_SCHEDULES.deathBoardStallSweep }, removeOnComplete: true },
  );
  return [queue];
}
