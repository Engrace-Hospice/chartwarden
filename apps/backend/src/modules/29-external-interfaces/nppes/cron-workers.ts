// apps/backend/src/modules/29-external-interfaces/nppes/cron-workers.ts — the LIVE BullMQ Worker +
// repeatable Queue for the platform NPPES sync (GAP-045). The M7/M25 `jobs/cron-workers.ts` template.
//
// `NPPES_SYNC_SCHEDULE` (./schedule) has always been pure data whose own comment says "the M29-T08 worker
// binds this to the BullMQ scheduler" — no such worker was ever written, so the nightly run never
// happened, `nppes_provider` / `nppes_sync_run` stayed empty in every deployment, and the only manual
// trigger 501'd. This file is that worker.
//
// ONE QUEUE, TWO ENTRY POINTS, ONE ENGINE:
//   · the repeatable `scheduled` job (02:30 UTC, `NPPES_SYNC_SCHEDULE.cronPattern`) → a
//     `daily_incremental` / `platform_cron` run;
//   · a manual job enqueued by the §4.1.4 `POST /nppes/sync-runs` route → a `manual` / `platform_admin`
//     run carrying the triggering platform actor.
// Both construct the SAME `NppesSyncOrchestrator` over the same Drizzle ports, so the manual path cannot
// drift from the nightly one.
//
// PLATFORM SINGLETON (§ notes 8). `concurrency: 1` on the worker plus a deterministic BullMQ `jobId` on
// the manual enqueue: two concurrent runs would double the CMS request budget against a public API with
// no contract behind it. The nightly repeatable is inherently single (BullMQ emits one job per pattern
// fire); the manual jobId dedups a double-clicked operator button within the job's retention window.
//
// THE SYNC RUN ID IS MINTED BY THE CALLER, not the orchestrator's default. The route must answer with the
// id an operator can then poll `GET /nppes/sync-runs` for, and the job may not have started yet — so the
// id travels IN the job payload and `newSyncRunId` returns it. A cron job carries none and the worker
// mints one.
import { randomUUID } from "node:crypto";

import type { DbClient } from "@chartwarden/db";
import type { NppesSyncKind, NppesSyncRunId, NppesSyncTrigger } from "@chartwarden/types";
import { type ConnectionOptions, Queue, Worker } from "bullmq";

import { NppesClient, type NppesClientConfig } from "./nppes-client";
import { type NppesOutboxPublishPort, buildNppesOutboxSink } from "./outbox-sink";
import { NPPES_SYNC_SCHEDULE } from "./schedule";
import { createDrizzleNppesProviderCache, createDrizzleNppesSyncRunStore } from "./stores-drizzle";
import {
  type NppesNpiSourcePort,
  NppesSyncOrchestrator,
  type SyncResult,
} from "./sync-orchestrator";

/** The payload a queued NPPES sync job carries. A cron fire enqueues `{}` (all fields defaulted). */
export interface NppesSyncJobData {
  readonly syncRunId?: string;
  readonly kind?: NppesSyncKind;
  readonly triggeredBy?: NppesSyncTrigger;
  /** The platform actor for a manual run; absent/null for the nightly cron. */
  readonly triggeredByMembershipId?: string | null;
}

export interface NppesSyncWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: NppesOutboxPublishPort;
  /**
   * The distinct NPIs to refresh. INJECTED rather than built here: the list comes from M40's canonical
   * `external_physician`, and `arch:tables` (rightly) refuses a read of another module's table from M29
   * code. The composition root adapts `modules/40-mdm/nppes-npi-source.ts` into this port.
   */
  readonly npiSource: NppesNpiSourcePort;
  /**
   * The HTTP surface the CMS NPI Registry client calls. Injected so the live suite drives the whole
   * orchestration without the network; the composition root passes the platform `fetch`.
   */
  readonly httpFetch?: typeof globalThis.fetch;
  /**
   * Optional `NppesClient` overrides (request cadence, retry ceiling, the backoff `sleep`). Left unset in
   * production so the client's own CMS-courteous defaults apply; the live suite pins `maxRetries: 0` and a
   * no-op sleep so an outage test measures the ORCHESTRATION, not thirty seconds of real backoff.
   */
  readonly clientOverrides?: Partial<
    Pick<NppesClientConfig, "maxRetries" | "sleep" | "requestsPerSecond">
  >;
  readonly log?: (
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>,
  ) => void;
  readonly now?: () => Date;
}

/** Build the orchestrator for one run. Constructed per job so `newSyncRunId` can close over the job's id. */
export function buildNppesSyncOrchestrator(
  deps: NppesSyncWorkerDeps,
  syncRunId: NppesSyncRunId,
): NppesSyncOrchestrator {
  const fetchImpl = deps.httpFetch ?? globalThis.fetch;
  return new NppesSyncOrchestrator({
    npiSource: deps.npiSource,
    fetcher: new NppesClient({
      fetch: (url, init) => fetchImpl(url, init as RequestInit),
      log: deps.log,
      ...deps.clientOverrides,
    }),
    cache: createDrizzleNppesProviderCache(deps.db),
    runStore: createDrizzleNppesSyncRunStore(deps.db),
    outbox: buildNppesOutboxSink({ db: deps.db, outbox: deps.outbox, syncRunId }),
    now: deps.now ?? (() => new Date()),
    newSyncRunId: () => syncRunId,
    log: deps.log,
  });
}

/**
 * Run one NPPES sync from a queued job. `triggerScope` is hardcoded `platform` here and NOWHERE else:
 * this function is only reachable from the BullMQ worker, and the §4.1.4 route that enqueues a manual job
 * has already passed the `nppes_platform_job_caller` ABAC predicate (W-XI-12) before the job existed. The
 * orchestrator's own `NppesTenantTriggerRefusedError` guard stays as the second line of defence.
 */
export async function runNppesSyncJob(
  deps: NppesSyncWorkerDeps,
  data: NppesSyncJobData,
): Promise<SyncResult> {
  const syncRunId = (data.syncRunId ?? randomUUID()) as NppesSyncRunId;
  const orchestrator = buildNppesSyncOrchestrator(deps, syncRunId);
  return orchestrator.run({
    kind: data.kind ?? NPPES_SYNC_SCHEDULE.nightlyKind,
    triggeredBy: data.triggeredBy ?? NPPES_SYNC_SCHEDULE.nightlyTrigger,
    triggerScope: "platform",
    triggeredByMembershipId: data.triggeredByMembershipId ?? null,
  });
}

/** Construct the ONE NPPES-sync `Worker` (the caller owns lifecycle — `close()` on shutdown). */
export function registerNppesSyncWorker(deps: NppesSyncWorkerDeps): Worker[] {
  return [
    new Worker<NppesSyncJobData>(
      NPPES_SYNC_SCHEDULE.queueName,
      async (job) => runNppesSyncJob(deps, job.data ?? {}),
      { connection: deps.connection, concurrency: NPPES_SYNC_SCHEDULE.concurrency },
    ),
  ];
}

/**
 * Register the D11 nightly repeatable (02:30 UTC — after the ~23:00 UTC NPPES dissemination has
 * propagated to the API). Returns the `Queue` for the shutdown hook to `close()`.
 */
export async function scheduleNppesSyncJob(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue<NppesSyncJobData>(NPPES_SYNC_SCHEDULE.queueName, { connection });
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: NPPES_SYNC_SCHEDULE.cronPattern, tz: NPPES_SYNC_SCHEDULE.timezone },
      attempts: 1, // a failed run is recorded as a `failed` nppes_sync_run row, not re-walked blindly
      removeOnComplete: { count: 50 },
      removeOnFail: false,
    },
  );
  return [queue];
}

/** The §4.1.4 manual-trigger port the NPPES route calls. Enqueues; never runs the sync inline. */
export interface NppesManualSyncTrigger {
  enqueue(input: {
    readonly kind: NppesSyncKind;
    readonly triggeredByMembershipId: string;
  }): Promise<{ readonly syncRunId: string; readonly jobId: string }>;
}

/**
 * Build the manual trigger over a Queue handle. The sync run id is minted HERE so the route can answer
 * with it immediately; the worker opens the `nppes_sync_run` row under that id when the job starts, which
 * is why `GET /nppes/sync-runs` may briefly not list a just-triggered run (queued ≠ opened). The `jobId`
 * dedups a double-submit: BullMQ rejects a second add with the same id while the first is still retained.
 */
export function buildNppesManualSyncTrigger(connection: ConnectionOptions): {
  trigger: NppesManualSyncTrigger;
  queues: Queue[];
} {
  const queue = new Queue<NppesSyncJobData>(NPPES_SYNC_SCHEDULE.queueName, { connection });
  return {
    queues: [queue],
    trigger: {
      async enqueue({ kind, triggeredByMembershipId }) {
        const syncRunId = randomUUID();
        const jobId = `nppes-manual-${syncRunId}`;
        await queue.add(
          "manual",
          { syncRunId, kind, triggeredBy: "platform_admin", triggeredByMembershipId },
          { jobId, attempts: 1, removeOnComplete: { count: 50 }, removeOnFail: false },
        );
        return { syncRunId, jobId };
      },
    },
  };
}
