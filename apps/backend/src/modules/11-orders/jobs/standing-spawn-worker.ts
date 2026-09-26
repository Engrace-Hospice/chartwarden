// M11 D5 hourly standing-order orchestration. Clinical writes remain in OrderRouteService.
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import type { OrderRouteService } from "../routes/service";

export const M11_STANDING_SPAWN_QUEUE = "orders.standing_spawn";
export const M11_STANDING_SPAWN_SCHEDULE = "0 * * * *";
export const M11_PLATFORM_JOB_ID = "m11.standing_spawn";

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { organizationId: string }[]>;
}
export interface StandingSpawnWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly service: OrderRouteService;
  readonly activeOrgs: ActiveOrgListPort;
}

/** One hourly trigger fans out under the service's per-org `withOrgContext` boundary. */
export async function runStandingSpawnFanout(deps: StandingSpawnWorkerDeps): Promise<void> {
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      await deps.service.spawnDueStandingOrders(organizationId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `M11_STANDING_SPAWN: ${failures.length} org failure(s)`);
}

export function registerM11StandingSpawnWorker(deps: StandingSpawnWorkerDeps): Worker {
  return new Worker(M11_STANDING_SPAWN_QUEUE, async () => runStandingSpawnFanout(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

export async function scheduleM11StandingSpawn(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M11_STANDING_SPAWN_QUEUE, { connection });
  await queue.add(
    "hourly",
    {},
    {
      repeat: { pattern: M11_STANDING_SPAWN_SCHEDULE },
      jobId: "m11-standing-spawn-hourly",
      attempts: 3,
      backoff: { type: "exponential", delay: 120_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
