// apps/backend/src/modules/11-orders/jobs/order-sweeps-worker.ts — GAP-032: the BullMQ fan-outs for the three §4.8
// workers that were never built. THIN per-org fan-outs in the `stuck-transmission-worker.ts` shape: the decision and
// write logic is `../order-sweeps.ts`; this file decides WHEN and for WHICH orgs. One org's failure does not stop the
// rest; every error is re-raised together so BullMQ's attempt/backoff (and the DLQ alert) still see the job as failed.
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import {
  type CompletionFactsReader,
  type OrderSweepDeps,
  sweepCompletionWatcher,
  sweepLabResultsOverdue,
  sweepVerbalPreExpiry,
} from "../order-sweeps";
import type { ActiveOrgListPort } from "./standing-spawn-worker";

export const M11_VERBAL_PRE_EXPIRY_QUEUE = "orders.verbal_pre_expiry";
export const M11_VERBAL_PRE_EXPIRY_SCHEDULE = "*/15 * * * *";

export const M11_LAB_RESULTS_OVERDUE_QUEUE = "orders.lab_results_overdue";
/** D18 — daily 04:00 UTC. */
export const M11_LAB_RESULTS_OVERDUE_SCHEDULE = "0 4 * * *";

export const M11_COMPLETION_WATCHER_QUEUE = "orders.completion_watcher";
/** Daily 03:00 UTC (idempotent net, so one UTC tick is equivalent to the spec's per-org-tz tick). */
export const M11_COMPLETION_WATCHER_SCHEDULE = "0 3 * * *";

/** One platform-job id for the three fan-outs' audited org enumeration. */
export const M11_ORDER_SWEEPS_PLATFORM_JOB_ID = "m11.order_sweeps";

export interface OrderSweepWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly sweep: OrderSweepDeps;
  readonly activeOrgs: ActiveOrgListPort;
}

export interface CompletionWatcherWorkerDeps extends OrderSweepWorkerDeps {
  readonly facts: CompletionFactsReader;
}

async function fanOut(
  activeOrgs: ActiveOrgListPort,
  label: string,
  run: (organizationId: string) => Promise<unknown>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const { organizationId } of await activeOrgs.listActiveOrgs()) {
    try {
      await run(organizationId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `${label}: ${failures.length} org failure(s)`);
  }
}

export const runVerbalPreExpiryFanout = (deps: OrderSweepWorkerDeps): Promise<void> =>
  fanOut(deps.activeOrgs, "M11_VERBAL_PRE_EXPIRY", (org) => sweepVerbalPreExpiry(deps.sweep, org));

export const runLabResultsOverdueFanout = (deps: OrderSweepWorkerDeps): Promise<void> =>
  fanOut(deps.activeOrgs, "M11_LAB_RESULTS_OVERDUE", (org) =>
    sweepLabResultsOverdue(deps.sweep, org),
  );

export const runCompletionWatcherFanout = (deps: CompletionWatcherWorkerDeps): Promise<void> =>
  fanOut(deps.activeOrgs, "M11_COMPLETION_WATCHER", (org) =>
    sweepCompletionWatcher({ ...deps.sweep, facts: deps.facts }, org),
  );

export function registerM11OrderSweepWorkers(deps: CompletionWatcherWorkerDeps): Worker[] {
  const opts = { connection: deps.connection, concurrency: 1 };
  return [
    new Worker(M11_VERBAL_PRE_EXPIRY_QUEUE, async () => runVerbalPreExpiryFanout(deps), opts),
    new Worker(M11_LAB_RESULTS_OVERDUE_QUEUE, async () => runLabResultsOverdueFanout(deps), opts),
    new Worker(M11_COMPLETION_WATCHER_QUEUE, async () => runCompletionWatcherFanout(deps), opts),
  ];
}

const SCHEDULES = [
  {
    queue: M11_VERBAL_PRE_EXPIRY_QUEUE,
    pattern: M11_VERBAL_PRE_EXPIRY_SCHEDULE,
    id: "m11-verbal-pre-expiry-15m",
  },
  {
    queue: M11_LAB_RESULTS_OVERDUE_QUEUE,
    pattern: M11_LAB_RESULTS_OVERDUE_SCHEDULE,
    id: "m11-lab-results-overdue-daily",
  },
  {
    queue: M11_COMPLETION_WATCHER_QUEUE,
    pattern: M11_COMPLETION_WATCHER_SCHEDULE,
    id: "m11-completion-watcher-daily",
  },
] as const;

export async function scheduleM11OrderSweeps(connection: ConnectionOptions): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (const s of SCHEDULES) {
    const queue = new Queue(s.queue, { connection });
    await queue.add(
      "tick",
      {},
      {
        repeat: { pattern: s.pattern },
        jobId: s.id,
        attempts: 3,
        backoff: { type: "exponential", delay: 120_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    queues.push(queue);
  }
  return queues;
}
