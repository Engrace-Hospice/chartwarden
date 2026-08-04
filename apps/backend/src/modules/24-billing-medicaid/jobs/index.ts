// apps/backend/src/modules/24-billing-medicaid/jobs — the M24 §4.9 job-surface barrel + the BullMQ worker
// construction (the M26 jobs/index template). The pure cron handlers (m24-jobs.ts) + the queue catalog
// (queues.ts) stay importable without bullmq; this file adds the worker/schedule construction. The per-state
// adapter + the M2 active-org enumerator + the M36 alert router carry fail-closed/no-op defaults until the
// integrator binds them — constructing the workers stays green; a port only throws WHEN A CRON TICK RUNS.
// Nothing here runs at import (constructing a Worker opens Valkey).
//
// BOOT-WIRING DEFERRED (the M26 posture + this P3 scope): the composition root does NOT yet construct these
// workers — the submit/poll/ack-pull/revalidate execution path needs the live per-state adapter. The job
// surface is exported module-only so the wiring is a one-line follow-up once the adapter wire I/O binds.
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { M24_CRON_QUEUES, M24_JOB_SCHEDULES, M24_QUEUE_PARAMS } from "./queues";

export * from "./m24-jobs";
export * from "./queues";

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

const FAIL_CLOSED_ORGS: ActiveOrgListPort = {
  async listActiveOrgs() {
    throw new Error(
      "M24 cron: active-org enumerator not bound (fail-closed until the M2 enumerator binds)",
    );
  },
};

export interface M24WorkerDeps {
  readonly connection: ConnectionOptions;
  now?: () => Date;
  readonly activeOrgs?: ActiveOrgListPort;
}

/** Construct the M24 §4.9 cron workers over the injected Valkey connection (the M26 worker-runner shape). */
export function registerM24CronWorkers(deps: M24WorkerDeps): Worker[] {
  const activeOrgs = deps.activeOrgs ?? FAIL_CLOSED_ORGS;
  const opts = { connection: deps.connection } as const;
  // The cron bodies fan out per active org; the org-scoped store reads bind with the per-state adapter
  // (deferred). Until then a tick fails closed at the enumerator (never at import).
  const eligibility = new Worker(
    M24_CRON_QUEUES.eligibilityStaleWatchdog,
    async () => {
      await activeOrgs.listActiveOrgs();
    },
    { ...opts, concurrency: M24_QUEUE_PARAMS.eligibilityStaleWatchdog.concurrency },
  );
  const rbSweep = new Worker(
    M24_CRON_QUEUES.rbDayDailySweep,
    async () => {
      await activeOrgs.listActiveOrgs();
    },
    { ...opts, concurrency: M24_QUEUE_PARAMS.rbDayDailySweep.concurrency },
  );
  return [eligibility, rbSweep];
}

/** Register the §4.9 repeatable cron schedules (UTC) on the platform Valkey. Returns the Queues to close. */
export async function scheduleM24Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const eligibility = new Queue(M24_CRON_QUEUES.eligibilityStaleWatchdog, { connection });
  const rbSweep = new Queue(M24_CRON_QUEUES.rbDayDailySweep, { connection });
  await eligibility.add(
    "tick",
    {},
    { repeat: { pattern: M24_JOB_SCHEDULES.eligibilityStaleWatchdog, tz: "UTC" } },
  );
  await rbSweep.add(
    "tick",
    {},
    { repeat: { pattern: M24_JOB_SCHEDULES.rbDayDailySweep, tz: "UTC" } },
  );
  return [eligibility, rbSweep];
}
