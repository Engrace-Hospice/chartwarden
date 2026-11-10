// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-sweep.ts — the help-request expiry sweep (slice 7, piece 7B).
//
// Every five minutes, on the audited platform credential (it reads and writes across tenants), the sweep ends two kinds of
// request, both closed by the SYSTEM (no user is named):
//   * an `open` request nobody answered in 14 days is CANCELLED, so a stale request never blocks the tenant's one live slot;
//   * an `approved` request whose consent grant has expired or been revoked is RESOLVED: the help it stood on is over.
// The support-session close sweep (piece 7S) ends the sessions themselves; this job ends the REQUESTS, so it never touches the
// support tables except to read the grant. A tick that finds nothing writes nothing. Its own queue, registered with the worker
// registry in the composition root (never inside platform-sweeps-worker.ts).
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { HelpRequestRunner } from "./help-request-store";

/** This module's BullMQ queue for the help-request sweep (`arch:queue-names` keeps every queue name to one owner). */
export const HELP_REQUEST_SWEEP_QUEUE = "tenant.help_request_sweep";
/** Every five minutes: the cadence of the support-session close sweep whose grants this one follows. */
export const HELP_REQUEST_SWEEP_SCHEDULE = "*/5 * * * *";
/** How long an unanswered request waits before it is cancelled. */
export const HELP_REQUEST_OPEN_MAX_AGE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

export interface HelpRequestSweepResult {
  /** `open` requests older than 14 days, now cancelled. */
  readonly cancelled: number;
  /** `approved` requests whose grant is no longer active, now resolved. */
  readonly resolved: number;
}

/** One tick: both scans in ONE platform transaction (the bypass audit row says why it was opened). */
export function runHelpRequestSweep(
  runner: HelpRequestRunner,
  now: () => Date = () => new Date(),
): Promise<HelpRequestSweepResult> {
  return runner.asPlatform({ userId: null, reason: "m34 help request sweep" }, async (store) => {
    const at = now();
    const staleBefore = new Date(at.getTime() - HELP_REQUEST_OPEN_MAX_AGE_DAYS * MS_PER_DAY);
    const cancelled = await store.cancelStaleOpen(staleBefore, at);
    const resolved = await store.resolveGrantEnded(at);
    return { cancelled, resolved };
  });
}

export interface HelpRequestSweepWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly runner: HelpRequestRunner;
  readonly now?: () => Date;
}

/** Construct the `tenant.help_request_sweep` Worker (one run at a time: a tick is a pair of idempotent statements). */
export function registerM34HelpRequestSweepWorker(deps: HelpRequestSweepWorkerDeps): Worker {
  return new Worker(
    HELP_REQUEST_SWEEP_QUEUE,
    async () => runHelpRequestSweep(deps.runner, deps.now),
    {
      connection: deps.connection,
      concurrency: 1,
    },
  );
}

/** Register the repeatable tick; returns the schedule `Queue` so the composition root can `close()` it. */
export async function scheduleM34HelpRequestSweepJob(
  connection: ConnectionOptions,
): Promise<Queue> {
  const queue = new Queue(HELP_REQUEST_SWEEP_QUEUE, { connection });
  await queue.add(
    "scheduled",
    {},
    { repeat: { pattern: HELP_REQUEST_SWEEP_SCHEDULE }, removeOnComplete: true },
  );
  return queue;
}
