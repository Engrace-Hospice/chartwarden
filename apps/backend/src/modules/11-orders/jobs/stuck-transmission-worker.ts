// apps/backend/src/modules/11-orders/jobs/stuck-transmission-worker.ts — the `orders.stuck_transmission` BullMQ fan-out
// for M11's stuck-lab-order recovery (F-193, #248). A THIN per-org fan-out, the `verbal-order-expiry-worker.ts` shape
// verbatim: the decision and write logic is `StuckTransmissionRecovery` (`../stuck-transmission-recovery.ts`), this file
// only decides WHEN and for WHICH orgs. Building a second set of queries here would duplicate the guard-before-write
// discipline the service already gets right.
//
// EVERY 15 MINUTES. The auto-retry backoff starts at 10 minutes (a transient `dependency_unavailable` should clear
// fast) and the held-order stages are hours apart, so a quarter-hour tick resolves both without polling harder than the
// signals change. It is NOT a request: the org list comes from the audited platform-context enumerator and each service
// call opens its own `withOrgContext` transaction before touching an order.
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import type { StuckTransmissionRecovery } from "../stuck-transmission-recovery";
import type { ActiveOrgListPort } from "./standing-spawn-worker";

export const M11_STUCK_TRANSMISSION_QUEUE = "orders.stuck_transmission";
export const M11_STUCK_TRANSMISSION_SCHEDULE = "*/15 * * * *";
/** Distinct from the other M11 sweeps' job ids so this fan-out's cross-tenant org enumeration audits under its own name. */
export const M11_STUCK_TRANSMISSION_PLATFORM_JOB_ID = "m11.stuck_transmission";

export interface StuckTransmissionWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly service: Pick<StuckTransmissionRecovery, "sweepAutoRetries" | "sweepHeldAging">;
  readonly activeOrgs: ActiveOrgListPort;
}

/**
 * One tick, every active org. The two sweeps for an org are independent (a failing auto-retry must not silence the
 * held-order escalation), and one org's failure does not stop the rest: every error is collected and re-raised together so
 * BullMQ's own attempt/backoff policy still sees the job as failed instead of a whole org's sweep vanishing silently.
 */
export async function runStuckTransmissionFanout(
  deps: Pick<StuckTransmissionWorkerDeps, "service" | "activeOrgs">,
): Promise<void> {
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    for (const sweep of [deps.service.sweepAutoRetries, deps.service.sweepHeldAging]) {
      try {
        await sweep(organizationId);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `M11_STUCK_TRANSMISSION: ${failures.length} sweep failure(s)`);
  }
}

export function registerM11StuckTransmissionWorker(deps: StuckTransmissionWorkerDeps): Worker {
  return new Worker(M11_STUCK_TRANSMISSION_QUEUE, async () => runStuckTransmissionFanout(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

export async function scheduleM11StuckTransmission(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M11_STUCK_TRANSMISSION_QUEUE, { connection });
  await queue.add(
    "every-15-minutes",
    {},
    {
      repeat: { pattern: M11_STUCK_TRANSMISSION_SCHEDULE },
      jobId: "m11-stuck-transmission-15m",
      attempts: 3,
      backoff: { type: "exponential", delay: 120_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
