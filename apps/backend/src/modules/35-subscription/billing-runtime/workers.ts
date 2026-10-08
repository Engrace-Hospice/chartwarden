// apps/backend/src/modules/35-subscription/billing-runtime/workers.ts - GAP-058 / GAP-059.
//
// The BullMQ shell over the M35 jobs (./jobs.ts, ./webhook-handler.ts, ./refund-executor.ts). Constructed by the
// composition root only with a Valkey connection (constructing a Worker opens it - never at import, never in
// tests) and only when the platform pool exists (the org enumerator and the platform-only tables need it).
// Every queue is a repeatable SWEEP over durable rows, not a per-request job: a lost job loses nothing.
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  type M35JobDeps,
  runDunningForOrg,
  runInvoiceReconcileForOrg,
  runM35Fanout,
  runPaymentMethodExpiryForOrg,
  runRevenueSnapshot,
  runUsageAggregationForOrg,
} from "./jobs";
import { type RefundExecutorDeps, runRefundExecutionSweep } from "./refund-executor";
import { runWebhookHandlerSweep } from "./webhook-handler";
import type { WebhookPayloadCipher } from "./webhook-payload-crypto";

/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M35_JOBS_PLATFORM_JOB_ID = "m35.jobs";

export const M35_QUEUES = {
  dunningEngine: "m35.dunning-engine",
  paymentMethodExpiry: "m35.payment-method-expiry-watch",
  usageAggregator: "m35.usage-aggregator",
  revenueSnapshot: "m35.revenue-snapshot",
  invoiceReconciler: "m35.subscription-reconciler",
  webhookHandler: "m35.stripe-webhook-handler",
  refundExecutor: "m35.refund-executor",
} as const;

/** Cron patterns (UTC). Sweeps that wait on Stripe-driven state run often; calendar jobs run once. */
export const M35_SCHEDULES = {
  dunningEngine: "0 * * * *",
  paymentMethodExpiry: "0 6 * * *",
  usageAggregator: "15 * * * *",
  revenueSnapshot: "0 3 1 * *",
  invoiceReconciler: "0 4 * * *",
  webhookHandler: "* * * * *",
  refundExecutor: "*/5 * * * *",
} as const;

export interface M35WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly jobs: M35JobDeps;
  /** Present when `M35_WEBHOOK_PAYLOAD_KEY` is configured - without it stored payloads cannot be read. */
  readonly cipher?: WebhookPayloadCipher;
  /** Present when `STRIPE_SECRET_KEY` is configured - without it refunds are NOT executed (stay approved). */
  readonly refunds?: RefundExecutorDeps;
}

/** One Worker per bound queue. */
export function registerM35Workers(deps: M35WorkerDeps): Worker[] {
  const { connection, jobs } = deps;
  const worker = (name: string, run: () => Promise<unknown>) =>
    new Worker(name, async () => void (await run()), { connection, concurrency: 1 });

  const workers: Worker[] = [
    worker(M35_QUEUES.dunningEngine, () =>
      runM35Fanout(jobs, (o) => runDunningForOrg(jobs, o).then(() => undefined), "dunning_engine"),
    ),
    worker(M35_QUEUES.paymentMethodExpiry, () =>
      runM35Fanout(
        jobs,
        (o) => runPaymentMethodExpiryForOrg(jobs, o).then(() => undefined),
        "pm_expiry",
      ),
    ),
    worker(M35_QUEUES.usageAggregator, () =>
      runM35Fanout(
        jobs,
        (o) => runUsageAggregationForOrg(jobs, o).then(() => undefined),
        "usage_aggregator",
      ),
    ),
    worker(M35_QUEUES.invoiceReconciler, () =>
      runM35Fanout(
        jobs,
        (o) => runInvoiceReconcileForOrg(jobs, o).then(() => undefined),
        "reconciler",
      ),
    ),
    worker(M35_QUEUES.revenueSnapshot, () => runRevenueSnapshot(jobs)),
  ];
  if (deps.cipher) {
    const cipher = deps.cipher;
    workers.push(
      worker(M35_QUEUES.webhookHandler, () => runWebhookHandlerSweep({ ...jobs, cipher })),
    );
  }
  if (deps.refunds) {
    const refunds = deps.refunds;
    workers.push(worker(M35_QUEUES.refundExecutor, () => runRefundExecutionSweep(refunds)));
  }
  return workers;
}

/** Register the repeatable triggers for the queues {@link registerM35Workers} constructs. */
export async function scheduleM35Jobs(
  connection: ConnectionOptions,
  opts: { webhookHandler: boolean; refundExecutor: boolean },
): Promise<Queue[]> {
  const specs: Array<{ name: string; pattern: string }> = [
    { name: M35_QUEUES.dunningEngine, pattern: M35_SCHEDULES.dunningEngine },
    { name: M35_QUEUES.paymentMethodExpiry, pattern: M35_SCHEDULES.paymentMethodExpiry },
    { name: M35_QUEUES.usageAggregator, pattern: M35_SCHEDULES.usageAggregator },
    { name: M35_QUEUES.invoiceReconciler, pattern: M35_SCHEDULES.invoiceReconciler },
    { name: M35_QUEUES.revenueSnapshot, pattern: M35_SCHEDULES.revenueSnapshot },
    ...(opts.webhookHandler
      ? [{ name: M35_QUEUES.webhookHandler, pattern: M35_SCHEDULES.webhookHandler }]
      : []),
    ...(opts.refundExecutor
      ? [{ name: M35_QUEUES.refundExecutor, pattern: M35_SCHEDULES.refundExecutor }]
      : []),
  ];
  const queues: Queue[] = [];
  for (const { name, pattern } of specs) {
    const queue = new Queue(name, { connection });
    await queue.add("scheduled", {}, { repeat: { pattern }, removeOnComplete: true });
    queues.push(queue);
  }
  return queues;
}
