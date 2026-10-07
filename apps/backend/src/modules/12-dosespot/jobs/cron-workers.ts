// apps/backend/src/modules/12-dosespot/jobs/cron-workers.ts — the LIVE BullMQ Workers + repeatable Queues for the
// seven §4.8 M12 crons (GAP-037; the M13 `cron-workers.ts` shape). Each cron fans out over the active orgs and runs
// one org-explicit pass per org. The vendor-facing crons (transmit, recovery drain, status sweep, benefit prewarm)
// run ONLY for tenants that have a complete DoseSpot configuration — an unconfigured tenant is skipped, never
// failed, so its orders are not exhausted by an adapter that was never bound for it.
import type { DbClient } from "@wardenx/db";
import type { DoseSpotTenantConfigResolver } from "@wardenx/dosespot";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import {
  type ActiveOrgListPort,
  CRON_USER_ID,
  type M12CronDeps,
  runForEachActiveOrg,
} from "./cron-common";
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
import { runRecoveryDrainForOrg, runTransmitNewRxForOrg } from "./transmit-newrx";

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
  const fanOut =
    (label: string, perOrg: (org: string) => Promise<unknown>, vendorBound: boolean) =>
    async () => {
      await runForEachActiveOrg(label, deps.activeOrgs, async (org) => {
        if (vendorBound && !deps.config.isConfiguredFor(org)) return;
        await perOrg(org);
      });
      if (deps.breakerEdges) {
        await deps.breakerEdges.flush(deps.db, deps.outbox, deps.now ?? (() => new Date()));
      }
    };
  return {
    transmitNewRx: fanOut("M12_TRANSMIT_NEWRX", (o) => runTransmitNewRxForOrg(deps, o), true),
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
