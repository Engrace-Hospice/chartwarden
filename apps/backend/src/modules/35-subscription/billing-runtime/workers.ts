// apps/backend/src/modules/35-subscription/billing-runtime/workers.ts - GAP-058 / GAP-059.
//
// The BullMQ shell over the M35 jobs (./jobs.ts, ./webhook-handler.ts, ./refund-executor.ts). Constructed by the
// composition root only with a Valkey connection (constructing a Worker opens it - never at import, never in
// tests) and only when the platform pool exists (the org enumerator and the platform-only tables need it).
// Every queue is a repeatable SWEEP over durable rows, not a per-request job: a lost job loses nothing.
import type { PseudonymKeyProvider } from "@chartwarden/subscription-billing";
import type { NetCollectionsReader, PatientCensusReader } from "@chartwarden/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  type DailyCensusObservation,
  observeDailyCensus,
  recordDailyCensusBatch,
} from "../pricing/census-daily";
import { listContractedOrgIds } from "../pricing/contract-select";
import type { GoLiveReader } from "../pricing/ports";
import { CENSUS_SWEEP_INTERVAL_HOURS } from "../pricing/statement-period";
import { type StatementStripePort, runStatementSweep } from "../pricing/statement-service";
import { type CensusDeps, aggregateAddonForOrg, runPatientCensusForOrg } from "./census";
import {
  type M35JobDeps,
  runDunningForOrg,
  runInvoiceReconcileForOrg,
  runM35Fanout,
  runPaymentMethodExpiryForOrg,
  runRevenueSnapshot,
  runUsageAggregationForOrg,
} from "./jobs";
import { runPauseResumeSweep } from "./pause-resume";
import { type RefundExecutorDeps, runRefundExecutionSweep } from "./refund-executor";
import { runWebhookHandlerSweep } from "./webhook-handler";
import type { WebhookPayloadCipher } from "./webhook-payload-crypto";

const nowOf = (jobs: { readonly now?: () => Date }): Date => (jobs.now ?? (() => new Date()))();

/** The platform job id the active-org enumeration enters `withPlatformContext` under (registered at boot). */
export const M35_JOBS_PLATFORM_JOB_ID = "m35.jobs";

const M35_QUEUES = {
  dunningEngine: "m35.dunning-engine",
  paymentMethodExpiry: "m35.payment-method-expiry-watch",
  usageAggregator: "m35.usage-aggregator",
  revenueSnapshot: "m35.revenue-snapshot",
  invoiceReconciler: "m35.subscription-reconciler",
  webhookHandler: "m35.stripe-webhook-handler",
  refundExecutor: "m35.refund-executor",
  // ADR-0110 D8 — the claims-billing add-on census pull (M5 PatientCensusReader → patient_active_period).
  patientCensus: "m35.patient-census",
  // Slice 2 — the monthly statement of every org on a census_banded contract (draft while the month is open, final after).
  pricingStatement: "m35.pricing-statement",
  // An operator's pause whose end date has passed is resumed (the stored status follows the date; billing already counts it as over).
  pauseResume: "m35.subscription-pause-resume",
} as const;

/** Cron patterns (UTC). Sweeps that wait on Stripe-driven state run often; calendar jobs run once. */
const M35_SCHEDULES = {
  dunningEngine: "0 * * * *",
  paymentMethodExpiry: "0 6 * * *",
  usageAggregator: "15 * * * *",
  revenueSnapshot: "0 3 1 * *",
  invoiceReconciler: "0 4 * * *",
  webhookHandler: "* * * * *",
  refundExecutor: "*/5 * * * *",
  // the daily census sweep: the statement's expectation of how many days a month's census holds is derived from this interval
  patientCensus: `0 */${CENSUS_SWEEP_INTERVAL_HOURS} * * *`,
  pricingStatement: "30 * * * *",
  // hourly, between the dunning tick (:00) and the usage aggregator (:15), so a lapsed pause is normally back to `active` within the hour (later if the worker is late or skips the row)
  pauseResume: "5 * * * *",
} as const;

export interface M35WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly jobs: M35JobDeps;
  /** Present when `M35_WEBHOOK_PAYLOAD_KEY` is configured - without it stored payloads cannot be read. */
  readonly cipher?: WebhookPayloadCipher;
  /** Present when `STRIPE_SECRET_KEY` is configured - without it refunds are NOT executed (stay approved). */
  readonly refunds?: RefundExecutorDeps;
  /** ADR-0110 — present when the pseudonym key provider is bound; without it no census runs (nothing is counted). */
  readonly census?: Pick<CensusDeps, "census" | "keyProvider">;
  /**
   * Slice 2 (tenant pricing) - present when the pseudonym key ring is bound. Rides the SAME census sweep for the daily active-patient
   * count behind the average daily census, and runs the hourly statement sweep over the staff ledger, that count and the M25 net
   * collections seam. Without it no statement is computed (a statement needs all three meters; none is ever guessed).
   */
  readonly pricing?: {
    readonly census: Pick<PatientCensusReader, "activePatientCount">;
    readonly keyProvider: PseudonymKeyProvider;
    readonly netCollections: NetCollectionsReader;
    /** When a tenant went live (M34's tenant activation): statements are charged from the go-live day. */
    readonly goLive: GoLiveReader;
    readonly stripe?: StatementStripePort;
    /**
     * The backstop for "a tenant that bills outside ChartWarden pays no billing percentage": the M34 wizard sets the mode post-commit and
     * best effort, so a failure there is otherwise retried only by another clearinghouse change. The hourly pricing worker runs this for
     * every current contract, including onboarding and paused tenants with no statement run. Idempotent and cheap.
     */
    readonly reconcileOutsideMode?: (organizationId: string) => Promise<void>;
  };
}

/**
 * One org's statement step: first the outside-mode reconcile, then the statement. A reconcile that fails is logged and NEVER blocks the
 * statement: it is computed on the mode as it stands, and the next hourly sweep tries the reconcile again. What that retry corrects
 * depends on the tenant: while it is onboarding (nothing billed) the change applies at once; for a LIVE tenant the change is dated the
 * 1st of next month, like any mode change, so it cannot reprice the month being drafted.
 */
export async function reconcileThenStatement(
  reconcile: ((organizationId: string) => Promise<void>) | undefined,
  log: M35JobDeps["log"],
  statement: (organizationId: string) => Promise<unknown>,
  organizationId: string,
): Promise<void> {
  if (reconcile) {
    try {
      await reconcile(organizationId);
    } catch (err) {
      log?.("m35 outside billing mode reconcile failed for an org", {
        organizationId,
        err,
      });
    }
  }
  await statement(organizationId);
}

/**
 * Reconcile every not-canceled contract, including onboarding and paused tenants that have no statement run yet. The statement sweep's
 * own organization list is go-live filtered, so tying this repair to statement generation leaves precisely those non-live tenants stale.
 */
export async function reconcileOutsideModes(
  reconcile: ((organizationId: string) => Promise<void>) | undefined,
  log: M35JobDeps["log"],
  organizationIds: Iterable<string>,
): Promise<void> {
  if (!reconcile) return;
  for (const organizationId of organizationIds) {
    try {
      await reconcile(organizationId);
    } catch (err) {
      log?.("m35 outside billing mode reconcile failed for an org", { organizationId, err });
    }
  }
}

/** One hourly pricing tick: repair every current contract before generating any statements. */
export async function runPricingStatementTick(
  jobs: M35JobDeps,
  pricing: NonNullable<M35WorkerDeps["pricing"]>,
): Promise<void> {
  // Reconcile the current-contract population first. This deliberately includes onboarding and paused organizations: neither is
  // guaranteed to reach statement generation, but both may hold a contract whose mode must be none while billing outside.
  const current = await listContractedOrgIds(jobs.platformRunner, "current", nowOf(jobs));
  await reconcileOutsideModes(pricing.reconcileOutsideMode, jobs.log, current);
  // NOT the active-organisation list: a suspended or closed organisation's last month, and a canceled subscription's final month,
  // must still finalize. The ONE shared contract selector says which orgs can still need a statement.
  await runStatementSweep({
    platformRunner: jobs.platformRunner,
    keyProvider: pricing.keyProvider,
    netCollections: pricing.netCollections,
    goLive: pricing.goLive,
    ...(pricing.stripe ? { stripe: pricing.stripe } : {}),
    ...(jobs.now ? { now: jobs.now } : {}),
    ...(jobs.log ? { log: jobs.log } : {}),
  });
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
        // ADR-0110 — the claims-billing add-on aggregate rides the same sweep (plan meters first, then the add-on).
        (o) =>
          runUsageAggregationForOrg(jobs, o)
            .then(() => aggregateAddonForOrg(jobs, o))
            .then(() => undefined),
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
    worker(M35_QUEUES.pauseResume, () => runPauseResumeSweep(jobs)),
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
  if (deps.census) {
    const census: CensusDeps = {
      db: jobs.db,
      ...deps.census,
      ...(jobs.now ? { now: jobs.now } : {}),
      ...(jobs.log ? { log: jobs.log } : {}),
    };
    const pricing = deps.pricing;
    workers.push(
      worker(M35_QUEUES.patientCensus, async () => {
        // Slice 2 asks ONCE who is contracted, and writes the day's counts ONCE (every platform call is an audited bypass: two per sweep,
        // not one per org).
        const contracted = pricing
          ? await listContractedOrgIds(jobs.platformRunner, "live", nowOf(jobs))
          : new Set<string>();
        const observed: DailyCensusObservation[] = [];
        let fanoutFailure: unknown;
        try {
          await runM35Fanout(
            jobs,
            async (o) => {
              await runPatientCensusForOrg(census, o);
              // The same sweep, the same reader: one active-patient count per contracted org per UTC day for the ADC.
              if (pricing && contracted.has(o)) {
                observed.push(
                  await observeDailyCensus(
                    { census: pricing.census, ...(jobs.now ? { now: jobs.now } : {}) },
                    o,
                  ),
                );
              }
            },
            "patient_census",
          );
        } catch (error) {
          fanoutFailure = error; // the orgs that did answer are still recorded below; the failure is rethrown after
        }
        await recordDailyCensusBatch(
          { platformRunner: jobs.platformRunner, ...(jobs.now ? { now: jobs.now } : {}) },
          observed,
        );
        if (fanoutFailure) throw fanoutFailure;
      }),
    );
  }
  if (deps.pricing) {
    const pricing = deps.pricing;
    workers.push(worker(M35_QUEUES.pricingStatement, () => runPricingStatementTick(jobs, pricing)));
  }
  return workers;
}

/** Register the repeatable triggers for the queues {@link registerM35Workers} constructs. */
export async function scheduleM35Jobs(
  connection: ConnectionOptions,
  opts: {
    webhookHandler: boolean;
    refundExecutor: boolean;
    patientCensus?: boolean;
    pricingStatement?: boolean;
  },
): Promise<Queue[]> {
  const specs: Array<{ name: string; pattern: string }> = [
    { name: M35_QUEUES.dunningEngine, pattern: M35_SCHEDULES.dunningEngine },
    { name: M35_QUEUES.paymentMethodExpiry, pattern: M35_SCHEDULES.paymentMethodExpiry },
    { name: M35_QUEUES.usageAggregator, pattern: M35_SCHEDULES.usageAggregator },
    { name: M35_QUEUES.invoiceReconciler, pattern: M35_SCHEDULES.invoiceReconciler },
    { name: M35_QUEUES.revenueSnapshot, pattern: M35_SCHEDULES.revenueSnapshot },
    { name: M35_QUEUES.pauseResume, pattern: M35_SCHEDULES.pauseResume },
    ...(opts.webhookHandler
      ? [{ name: M35_QUEUES.webhookHandler, pattern: M35_SCHEDULES.webhookHandler }]
      : []),
    ...(opts.refundExecutor
      ? [{ name: M35_QUEUES.refundExecutor, pattern: M35_SCHEDULES.refundExecutor }]
      : []),
    ...(opts.patientCensus
      ? [{ name: M35_QUEUES.patientCensus, pattern: M35_SCHEDULES.patientCensus }]
      : []),
    ...(opts.pricingStatement
      ? [{ name: M35_QUEUES.pricingStatement, pattern: M35_SCHEDULES.pricingStatement }]
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
