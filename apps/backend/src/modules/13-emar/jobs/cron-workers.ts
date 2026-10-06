// apps/backend/src/modules/13-emar/jobs/cron-workers.ts — the LIVE BullMQ Worker + repeatable Queue
// construction for M13's six §4.8 crons (GAP-038 / GAP-039 / GAP-040; the M14 `jobs/cron-workers.ts`
// template). Each cron fans out over the active orgs and runs ONE org-explicit pass per org (every pass opens
// its own `withOrgContext` — a cron tick is not a request). An org's failure never stops the orgs after it:
// failures are collected and rethrown together so the job still fails (DLQ / alerting sees it) while every
// other tenant got its tick.
import type { DbClient } from "@wardenx/db";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";
import {
  runKitReturnOverdueForOrg,
  runPrnReassessmentOverdueForOrg,
  runReconciliationDueWarningForOrg,
} from "./deadline-sweeps";
import { type ExtendScheduleDeps, runExtendScheduleForOrg } from "./extend-schedule";
import { type MissedDoseSweepDeps, runMissedDoseSweepForOrg } from "./missed-dose-sweep";
import { runPurgeOfflineQueueForOrg } from "./purge-offline-queue";
import {
  type M13CronQueueName,
  M13_CRON_QUEUES,
  M13_CRON_QUEUE_PARAMS,
  M13_CRON_SCHEDULES,
} from "./queues";

/** The M2 active-org enumerator every M13 cron's fan-out reads (runs under `withPlatformContext`). */
export interface M13ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M13CronDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
  readonly activeOrgs: M13ActiveOrgListPort;
  /** M12 org-explicit order facts (`medicationOrderScheduleContextForOrg`). */
  readonly orderContext: ExtendScheduleDeps["orderContext"];
  /** M1 `FoundationSiteReader.locationTimezone`, org-explicit. */
  readonly locationTimezone: ExtendScheduleDeps["locationTimezone"];
  /** M9 `ScaleSeriesProvider` reassessment-captured check, bound under `runWithRequestContext`. */
  readonly reassessmentCaptured: Parameters<
    typeof runPrnReassessmentOverdueForOrg
  >[0]["reassessmentCaptured"];
  readonly now?: () => Date;
}

/** Run `perOrg` for every active org; collect failures and rethrow them together AFTER the last org. */
export async function runForEachActiveOrg(
  label: string,
  activeOrgs: M13ActiveOrgListPort,
  perOrg: (organizationId: string) => Promise<unknown>,
): Promise<void> {
  const orgs = await activeOrgs.listActiveOrgs();
  const failures: { organizationId: string; error: unknown }[] = [];
  for (const { organizationId } of orgs) {
    try {
      await perOrg(organizationId);
    } catch (error) {
      failures.push({ organizationId, error });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      `${label}: ${failures.length} of ${orgs.length} org(s) failed — ${failures.map((f) => f.organizationId).join(", ")}`,
    );
  }
}

/** The cron entry points, exported so a live suite drives a tick without a BullMQ Worker. */
export function buildM13CronRunners(
  deps: M13CronDeps,
): Record<keyof typeof M13_CRON_QUEUES, () => Promise<void>> {
  const base = { db: deps.db, outbox: deps.outbox, now: deps.now };
  const missedDeps: MissedDoseSweepDeps = {
    ...base,
    orderFacts: async (organizationId, orderId) => {
      const ctx = await deps.orderContext(organizationId, orderId);
      return ctx ? { isControlledSubstance: ctx.isControlledSubstance } : null;
    },
  };
  const extendDeps: ExtendScheduleDeps = {
    ...base,
    orderContext: deps.orderContext,
    locationTimezone: deps.locationTimezone,
  };
  const prnDeps = { ...base, reassessmentCaptured: deps.reassessmentCaptured };
  const fanOut = (label: string, perOrg: (organizationId: string) => Promise<unknown>) => () =>
    runForEachActiveOrg(label, deps.activeOrgs, perOrg);
  return {
    extendSchedule: fanOut("M13_EXTEND_SCHEDULE", (org) =>
      runExtendScheduleForOrg(extendDeps, org),
    ),
    missedDoseSweep: fanOut("M13_MISSED_DOSE_SWEEP", (org) =>
      runMissedDoseSweepForOrg(missedDeps, org),
    ),
    reconciliationDueWarning: fanOut("M13_RECONCILIATION_DUE_WARNING", (org) =>
      runReconciliationDueWarningForOrg(base, org),
    ),
    kitReturnOverdue: fanOut("M13_KIT_RETURN_OVERDUE", (org) =>
      runKitReturnOverdueForOrg(base, org),
    ),
    prnReassessmentOverdue: fanOut("M13_PRN_REASSESSMENT_OVERDUE", (org) =>
      runPrnReassessmentOverdueForOrg(prnDeps, org),
    ),
    purgeOfflineQueue: fanOut("M13_PURGE_OFFLINE_QUEUE", (org) =>
      runPurgeOfflineQueueForOrg({ db: deps.db, now: deps.now }, org),
    ),
  };
}

/** Construct the six M13 cron Workers (the caller owns lifecycle — `close()` on shutdown). */
export function registerM13CronWorkers(deps: M13CronDeps): Worker[] {
  const runners = buildM13CronRunners(deps);
  return (Object.keys(M13_CRON_QUEUES) as (keyof typeof M13_CRON_QUEUES)[]).map(
    (key) =>
      new Worker(M13_CRON_QUEUES[key], async () => runners[key](), {
        connection: deps.connection,
        concurrency: M13_CRON_QUEUE_PARAMS[key].concurrency,
      }),
  );
}

/** Register the §4.8 repeatable schedules. `removeOnFail: false` keeps each queue's failed set as its DLQ
 * (the M9/M10/M14 convention). Returns the `Queue`s to `close()`. */
export async function scheduleM13Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (const key of Object.keys(M13_CRON_QUEUES) as (keyof typeof M13_CRON_QUEUES)[]) {
    const name: M13CronQueueName = M13_CRON_QUEUES[key];
    const params = M13_CRON_QUEUE_PARAMS[key];
    const queue = new Queue(name, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern: M13_CRON_SCHEDULES[key] },
        priority: params.priority,
        attempts: params.attempts,
        backoff: { type: "exponential", delay: params.backoffMs },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
