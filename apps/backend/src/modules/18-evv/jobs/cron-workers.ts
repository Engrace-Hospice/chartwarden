// apps/backend/src/modules/18-evv/jobs/cron-workers.ts — the LIVE BullMQ Worker + repeatable Queue construction
// for M18's cron-driven §4.8 workers (incl. the `m18.dek-rotation` re-seal sweep) (GAP-056; the M13 `jobs/cron-workers.ts` template). Each cron fans out
// over the active orgs and runs ONE org-explicit pass per org (every pass opens its own `withOrgContext` — a cron
// tick is not a request). One org's failure never stops the orgs after it: failures are collected and rethrown
// together so the job still fails (DLQ / alerting sees it) while every other tenant got its tick.
import type { DbClient } from "@wardenx/db";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { EvvCoordsKeyProvider } from "../coords";
import type { EvvWriteOutboxPort } from "../evv-route-service-db";
import { createDrizzleCoordsResealStore, resealOrgCoords } from "./dek-rotation";
import { runLateCheckSweepForOrg } from "./late-check-sweep";
import type { EvvAggregatorDeps } from "./ports";
import {
  type M18CronQueueName,
  M18_CRON_QUEUES,
  M18_CRON_QUEUE_PARAMS,
  M18_CRON_SCHEDULES,
} from "./queues";
import { runAggregatorPollerForOrg, runAggregatorSubmitterForOrg } from "./submission-worker";

/** The M2 active-org enumerator every M18 cron's fan-out reads (runs under `withPlatformContext`). */
export interface M18ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M18CronDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: EvvWriteOutboxPort;
  readonly activeOrgs: M18ActiveOrgListPort;
  readonly aggregator: EvvAggregatorDeps;
  /** M34's key ring — the `m18.dek-rotation` sweep re-seals under its current DEK version. */
  readonly coordsKeys: EvvCoordsKeyProvider;
  readonly now?: () => Date;
}

/** Run `perOrg` for every active org; collect failures and rethrow them together AFTER the last org. */
export async function runForEachActiveOrg(
  label: string,
  activeOrgs: M18ActiveOrgListPort,
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
export function buildM18CronRunners(
  deps: M18CronDeps,
): Record<keyof typeof M18_CRON_QUEUES, () => Promise<void>> {
  const workerDeps = {
    db: deps.db,
    outbox: deps.outbox,
    aggregator: deps.aggregator,
    now: deps.now,
  };
  const resealStore = createDrizzleCoordsResealStore(deps.db);
  const fanOut = (label: string, perOrg: (organizationId: string) => Promise<unknown>) => () =>
    runForEachActiveOrg(label, deps.activeOrgs, perOrg);
  return {
    lateCheckSweep: fanOut("M18_LATE_CHECK_SWEEP", (org) =>
      runLateCheckSweepForOrg({ db: deps.db, outbox: deps.outbox, now: deps.now }, org),
    ),
    aggregatorSubmitter: fanOut("M18_AGGREGATOR_SUBMITTER_TICK", (org) =>
      runAggregatorSubmitterForOrg(workerDeps, org),
    ),
    aggregatorResponsePoller: fanOut("M18_AGGREGATOR_POLLER_TICK", (org) =>
      runAggregatorPollerForOrg(workerDeps, org),
    ),
    dekRotation: fanOut("M18_DEK_ROTATION_SWEEP", (org) =>
      resealOrgCoords({ store: resealStore, keys: deps.coordsKeys }, org),
    ),
  };
}

/** Construct the M18 cron Workers (the caller owns lifecycle — `close()` on shutdown). */
export function registerM18CronWorkers(deps: M18CronDeps): Worker[] {
  const runners = buildM18CronRunners(deps);
  return (Object.keys(M18_CRON_QUEUES) as (keyof typeof M18_CRON_QUEUES)[]).map(
    (key) =>
      new Worker(M18_CRON_QUEUES[key], async () => runners[key](), {
        connection: deps.connection,
        concurrency: M18_CRON_QUEUE_PARAMS[key].concurrency,
      }),
  );
}

/** Register the §4.8 repeatable schedules. `removeOnFail: false` keeps each queue's failed set as its DLQ
 * (the M9/M10/M13/M14 convention). Returns the `Queue`s to `close()`. */
export async function scheduleM18Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (const key of Object.keys(M18_CRON_QUEUES) as (keyof typeof M18_CRON_QUEUES)[]) {
    const name: M18CronQueueName = M18_CRON_QUEUES[key];
    const params = M18_CRON_QUEUE_PARAMS[key];
    const queue = new Queue(name, { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern: M18_CRON_SCHEDULES[key] },
        priority: params.priority,
        attempts: params.attempts,
        backoff: { type: params.backoffType, delay: params.backoffMs },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
