// WP 2.7b C2 (ADR-0058 decision 11, "Turning OFF") - the BullMQ shell of `messaging.search_maintenance`: every tick fans out
// over the active orgs (the same `fanOutOrgs` the integrity jobs use: one org failing never stops the others, then the tick
// FAILS with an AggregateError so it is visible in the failed set / DLQ alert). Per org: purge a requested OFF, then reconcile
// an enabled tenant. INERT while the flags are off: a tenant with no (or an OFF) setting row costs one small read.
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { type M36IntegrityWorkerDeps, fanOutOrgs } from "../jobs/integrity-workers";
import { purgeOrgIfRequested } from "./purge";
import { GLOBAL_SEARCH_MAINTENANCE_PATTERN, GLOBAL_SEARCH_QUEUES } from "./queue-names";
import { type ReconcileDeps, reconcileOrg } from "./reconcile";

export interface GlobalSearchMaintenanceDeps
  extends Pick<M36IntegrityWorkerDeps, "activeOrgs" | "onError"> {
  readonly connection: ConnectionOptions;
  readonly reconcile: ReconcileDeps;
}

type TickDeps = Pick<GlobalSearchMaintenanceDeps, "activeOrgs" | "onError" | "reconcile">;

export async function globalSearchMaintenanceTick(deps: TickDeps): Promise<number> {
  return fanOutOrgs(deps, "search_maintenance", async (organizationId) => {
    await purgeOrgIfRequested(deps.reconcile.db, organizationId);
    await reconcileOrg(deps.reconcile, organizationId);
  });
}

export function registerGlobalSearchMaintenanceWorker(deps: GlobalSearchMaintenanceDeps): Worker[] {
  return [
    new Worker(GLOBAL_SEARCH_QUEUES.maintenance, () => globalSearchMaintenanceTick(deps), {
      connection: deps.connection,
      concurrency: 1,
    }),
  ];
}

const SCHEDULED_JOB_NAME = "scheduled";
const SCHEDULER_ID = `${GLOBAL_SEARCH_QUEUES.maintenance}.schedule`;

/** Register the repeatable trigger (idempotent `upsertJobScheduler`, as the integrity jobs). Returns the `Queue`s to close. */
export async function scheduleGlobalSearchMaintenance(
  connection: ConnectionOptions,
): Promise<Queue[]> {
  const queue = new Queue(GLOBAL_SEARCH_QUEUES.maintenance, { connection });
  try {
    await queue.upsertJobScheduler(
      SCHEDULER_ID,
      { pattern: GLOBAL_SEARCH_MAINTENANCE_PATTERN },
      { name: SCHEDULED_JOB_NAME, data: {}, opts: { removeOnComplete: true, attempts: 1 } },
    );
    return [queue];
  } catch (error) {
    await queue.close();
    throw error;
  }
}
