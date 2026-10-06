// apps/backend/src/modules/24-billing-medicaid/jobs — the M24 §4.9 job-surface barrel + the BullMQ worker
// construction (the M26 jobs/index template). The pure cron handlers (m24-jobs.ts) + the queue catalog
// (queues.ts) stay importable without bullmq; this file adds the worker/schedule construction. The per-state
// adapter + the M2 active-org enumerator + the M36 alert router carry fail-closed/no-op defaults until the
// integrator binds them — constructing the workers stays green; a port only throws WHEN A CRON TICK RUNS.
// Nothing here runs at import (constructing a Worker opens Valkey).
//
// BOOT-WIRING (GAP-071): the eligibility-stale-watchdog + rb-day-daily-sweep crons run the real stores
// (rb-day-sweep.ts) the composition root injects; a store left unbound fails the tick closed (never silently
// no-ops). The submit/poll/ack-pull path is wired separately (submission-jobs.ts).
// Nothing here runs at import (constructing a Worker opens Valkey).
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  type EligibilityAlertPort,
  type EligibilityWatchdogStore,
  type RbDaySweepStore,
  runEligibilityStaleWatchdog,
  runRbDayDailySweep,
} from "./m24-jobs";
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
  readonly rbDaySweep?: RbDaySweepStore;
  readonly eligibilityWatchdog?: EligibilityWatchdogStore;
  /** Best-effort M36 alert dispatch for stale eligibility (an unbound port skips alerts). */
  readonly eligibilityAlerts?: EligibilityAlertPort;
  readonly log?: { error(err: unknown, msg: string): void };
}

const UNBOUND_STORE_MESSAGE =
  "M24 cron: store not bound (fail-closed until the composition root binds it)";
const MS_PER_DAY = 86_400_000;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Fan one org-scoped cron body out over every active org. One org's failure never starves the others; the
 * failures are logged per org and the tick then throws so BullMQ records it failed (never a silent success).
 */
export async function forEachActiveOrg(
  activeOrgs: ActiveOrgListPort,
  log: M24WorkerDeps["log"],
  label: string,
  body: (organizationId: string) => Promise<unknown>,
): Promise<void> {
  const orgs = await activeOrgs.listActiveOrgs();
  const failures: unknown[] = [];
  for (const { organizationId } of orgs) {
    try {
      await body(organizationId);
    } catch (err) {
      failures.push(err);
      log?.error(err, `${label} failed for org ${organizationId}`);
    }
  }
  if (failures.length > 0) throw new Error(`${label}: ${failures.length} org(s) failed`);
}

/** Construct the M24 §4.9 cron workers over the injected Valkey connection (the M26 worker-runner shape). */
export function registerM24CronWorkers(deps: M24WorkerDeps): Worker[] {
  const activeOrgs = deps.activeOrgs ?? FAIL_CLOSED_ORGS;
  const now = deps.now ?? (() => new Date());
  const opts = { connection: deps.connection } as const;
  const eligibility = new Worker(
    M24_CRON_QUEUES.eligibilityStaleWatchdog,
    async () => {
      const store = deps.eligibilityWatchdog;
      if (!store) throw new Error(UNBOUND_STORE_MESSAGE);
      await forEachActiveOrg(activeOrgs, deps.log, "M24 eligibility-stale-watchdog", (orgId) =>
        runEligibilityStaleWatchdog(store, orgId, isoDate(now()), deps.eligibilityAlerts, deps.log),
      );
    },
    { ...opts, concurrency: M24_QUEUE_PARAMS.eligibilityStaleWatchdog.concurrency },
  );
  const rbSweep = new Worker(
    M24_CRON_QUEUES.rbDayDailySweep,
    async () => {
      const store = deps.rbDaySweep;
      if (!store) throw new Error(UNBOUND_STORE_MESSAGE);
      // Sweep through the last COMPLETE UTC day (the cron fires at 01:30).
      const throughDay = isoDate(new Date(now().getTime() - MS_PER_DAY));
      await forEachActiveOrg(activeOrgs, deps.log, "M24 rb-day-daily-sweep", (orgId) =>
        runRbDayDailySweep(store, orgId, throughDay),
      );
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
