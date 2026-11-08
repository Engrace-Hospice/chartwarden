// apps/backend/src/modules/12-dosespot/jobs/cron-workers.ts — the LIVE BullMQ Workers + repeatable Queues for the
// seven §4.8 M12 crons (GAP-037; the M13 `cron-workers.ts` shape). Each cron fans out over the active orgs and runs
// one org-explicit pass per org. The vendor-facing crons (transmit, recovery drain, status sweep, benefit prewarm)
// run ONLY for tenants that have a complete DoseSpot configuration — an unconfigured tenant is skipped, never
// failed, so its orders are not exhausted by an adapter that was never bound for it.
import type { DbClient } from "@chartwarden/db";
import type { DoseSpotTenantConfigResolver } from "@chartwarden/dosespot";
import { withOrgContext } from "@chartwarden/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import {
  type ActiveOrgListPort,
  CRON_USER_ID,
  type M12CronDeps,
  runForEachActiveOrg,
} from "./cron-common";
import { runHeldAgeAlertForOrg, runQueuedAgeAlertForOrg } from "./degradation-reports";
import { runEpcsAttemptExpirySweepForOrg, runIal2ExpiryWarnForOrg } from "./ial2-and-epcs-sweeps";
import {
  type M12CronKey,
  M12_CRON_QUEUES,
  M12_CRON_QUEUE_PARAMS,
  M12_CRON_SCHEDULES,
} from "./queues";
import { runRefillSlaForOrg } from "./refill-sla";
import { runRxBenefitPrewarmForOrg } from "./rx-benefit-prewarm";
import { runTransmissionSweepForOrg } from "./transmission-sweep";
import {
  type TransmitPassResult,
  runRecoveryDrainForOrg,
  runTransmitNewRxForOrg,
} from "./transmit-newrx";

export interface BreakerEdge {
  readonly organizationId: string;
  readonly edge: "opened" | "closed";
  readonly lastErrorClass: string;
}

/**
 * Collects the HTTP adapter's breaker open/close edges (a synchronous callback) and publishes
 * `m12.dosespot_degraded` / `m12.dosespot_recovered` from the next cron tick, in an org transaction.
 */
export function createBreakerEdgeRecorder() {
  const pending: BreakerEdge[] = [];
  return {
    record(edge: BreakerEdge): void {
      pending.push(edge);
    },
    async flush(db: DbClient, outbox: DoseSpotWriteOutboxPort, now: () => Date): Promise<number> {
      const edges = pending.splice(0, pending.length);
      for (const e of edges) {
        await withOrgContext(
          db,
          { organizationId: e.organizationId, userId: CRON_USER_ID },
          async (tx) => {
            await outbox.publish(tx, {
              eventName: e.edge === "opened" ? "m12.dosespot_degraded" : "m12.dosespot_recovered",
              payload:
                e.edge === "opened"
                  ? {
                      breakerName: `dosespot:${e.organizationId}`,
                      openedAt: now().toISOString(),
                      lastErrorClass: e.lastErrorClass,
                    }
                  : { breakerName: `dosespot:${e.organizationId}`, closedAt: now().toISOString() },
              organizationId: e.organizationId,
              aggregateKind: "dosespot_adapter",
              aggregateId: e.organizationId,
            });
          },
        );
      }
      return edges.length;
    },
  };
}

export interface M12CronWorkerDeps extends M12CronDeps {
  readonly connection: ConnectionOptions;
  readonly activeOrgs: ActiveOrgListPort;
  readonly config: DoseSpotTenantConfigResolver;
  readonly breakerEdges?: ReturnType<typeof createBreakerEdgeRecorder>;
}

/** The cron entry points, exported so a live suite drives one tick without a BullMQ Worker. */
export function buildM12CronRunners(
  deps: M12CronWorkerDeps,
): Record<M12CronKey, () => Promise<void>> {
  /** The transmit pass inside a per-org result (the recovery drain nests it under `pass`). */
  const passOf = (result: unknown): Partial<TransmitPassResult> | undefined => {
    if (typeof result !== "object" || result === null) return undefined;
    const nested = (result as { pass?: unknown }).pass;
    return (
      typeof nested === "object" && nested !== null ? nested : result
    ) as Partial<TransmitPassResult>;
  };
  const fanOut =
    (
      label: string,
      perOrg: (org: string) => Promise<unknown>,
      vendorBound: boolean,
      /** Runs for EVERY active org, including one a vendor-bound cron skips as not configured. */
      forEveryOrg?: (org: string) => Promise<unknown>,
    ) =>
    async () => {
      let deferredByOutage = 0;
      let skipped = 0;
      let orgsSkippedByConfigFault = 0;
      let errored = 0;
      try {
        await runForEachActiveOrg(label, deps.activeOrgs, async (org) => {
          // the org's pass may throw (a claim that cannot be read, say): the every-org work (the age alerts) still runs for it, and the
          // pass's fault is rethrown after it, so runForEachActiveOrg still reports the org as failed
          let passFault: { readonly error: unknown } | null = null;
          try {
            if (!vendorBound || (await deps.config.isConfiguredFor(org))) {
              const pass = passOf(await perOrg(org));
              deferredByOutage += pass?.deferredByOutage ?? 0;
              skipped += pass?.skipped ?? 0;
              orgsSkippedByConfigFault += pass?.skippedConfigFault ?? 0;
              errored += pass?.errored ?? 0;
            }
          } catch (error) {
            passFault = { error };
          }
          await forEveryOrg?.(org);
          if (passFault !== null) throw passFault.error;
        });
      } finally {
        // orders sent back to `queued` (a registration that stopped being live mid-batch, an open circuit), orders whose claim was lost before the
        // worker could write (their result was discarded), orders whose attempt threw, and orgs skipped whole were never visible to the tick's
        // caller: say so, once per tick
        if (deferredByOutage > 0 || skipped > 0 || orgsSkippedByConfigFault > 0 || errored > 0) {
          deps.warn?.(
            { cron: label, deferredByOutage, skipped, orgsSkippedByConfigFault, errored },
            "M12 cron tick did not transmit every order it reached: some were deferred (an outage, an org skipped for a config fault), `skipped` were lost to another owner mid-pass, their result discarded, and `errored` threw and were passed over",
          );
        }
      }
      if (deps.breakerEdges) {
        await deps.breakerEdges.flush(deps.db, deps.outbox, deps.now ?? (() => new Date()));
      }
    };
  return {
    // the age alerts (queued past an hour, held past a day) cover every org, configured or not: either wait is the tenant's problem
    transmitNewRx: fanOut(
      "M12_TRANSMIT_NEWRX",
      (o) => runTransmitNewRxForOrg(deps, o),
      true,
      async (o) => {
        await runQueuedAgeAlertForOrg(deps, o);
        await runHeldAgeAlertForOrg(deps, o);
      },
    ),
    transmitQueuedOnRecovery: fanOut(
      "M12_TRANSMIT_QUEUED_ON_RECOVERY",
      (o) => runRecoveryDrainForOrg(deps, o),
      true,
    ),
    rxBenefitPrewarm: fanOut(
      "M12_RX_BENEFIT_PREWARM",
      (o) => runRxBenefitPrewarmForOrg(deps, o),
      true,
    ),
    refillSla: fanOut("M12_REFILL_SLA", (o) => runRefillSlaForOrg(deps, o), false),
    ial2ExpiryWarn: fanOut("M12_IAL2_EXPIRY_WARN", (o) => runIal2ExpiryWarnForOrg(deps, o), false),
    transmissionTimeoutSweep: fanOut(
      "M12_TRANSMISSION_TIMEOUT_SWEEP",
      (o) => runTransmissionSweepForOrg(deps, o),
      true,
    ),
    epcsAttemptExpirySweep: fanOut(
      "M12_EPCS_ATTEMPT_EXPIRY_SWEEP",
      (o) => runEpcsAttemptExpirySweepForOrg(deps, o),
      false,
    ),
  };
}

/** Construct the seven M12 cron Workers (the caller owns lifecycle — `close()` on shutdown). */
export function registerM12CronWorkers(deps: M12CronWorkerDeps): Worker[] {
  const runners = buildM12CronRunners(deps);
  return (Object.keys(M12_CRON_QUEUES) as M12CronKey[]).map(
    (key) =>
      new Worker(M12_CRON_QUEUES[key], async () => runners[key](), {
        connection: deps.connection,
        concurrency: M12_CRON_QUEUE_PARAMS[key].concurrency,
      }),
  );
}

/** Register the §4.8 repeatable schedules. `removeOnFail: false` keeps each queue's failed set as its DLQ. */
export async function scheduleM12Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queues: Queue[] = [];
  for (const key of Object.keys(M12_CRON_QUEUES) as M12CronKey[]) {
    const params = M12_CRON_QUEUE_PARAMS[key];
    const queue = new Queue(M12_CRON_QUEUES[key], { connection });
    await queue.add(
      "scheduled",
      {},
      {
        repeat: { pattern: M12_CRON_SCHEDULES[key] },
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
