// apps/backend/src/modules/26-cap/jobs — the M26 §4.8 job surface barrel + the BullMQ worker construction
// (the M25 cron-workers template, consolidated). The pure cron handlers (m26-jobs.ts) + the queue catalog
// (queues.ts) stay importable without bullmq; this file adds the Drizzle store bindings + the worker/schedule
// construction. The platform ports (the M2 active-org enumerator, the M36 alert router) carry a fail-closed
// thunk default until the integrator binds them — constructing the workers at boot stays green; a port only
// throws WHEN A CRON TICK RUNS. Nothing here runs at import (constructing a Worker opens Valkey).
import { type DbClient, schema } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { and, eq, lte, or, sql } from "drizzle-orm";
import {
  type PsrFileStorePort,
  type PsrReconcileEnqueuePort,
  reconcilePsrImport,
} from "../psr/psr-reconcile";
import type { WriteOutboxPort } from "../routes/write-service";
import { buildDrizzleM26WriteService } from "../routes/write-service-drizzle";
import { M26_WORKER_SYSTEM_USER_ID } from "../system-actor";
import {
  type CapYearCloseStore,
  type NightlyProjectionStore,
  type PsrWatchdogStore,
  runCapYearClose,
  runNightlyProjection,
  runPsrVarianceWatchdog,
} from "./m26-jobs";
import { M26_CRON_QUEUES, M26_JOB_SCHEDULES, M26_QUEUE_PARAMS } from "./queues";

export * from "./m26-jobs";
export * from "./queues";

/** The cron's write actor: the sentinel is stamped on authored rows (`closed_by`) only — the write service
 *  maps it to the NULL audit actor (`../system-actor.ts`), never into `app.user_id`. */
const sysActor = (orgId: string) => ({
  organizationId: orgId,
  userId: M26_WORKER_SYSTEM_USER_ID,
  roles: [],
});
const sysWriteActor = (orgId: string) => ({ ...sysActor(orgId), stepUpRecent: false });

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The §4.9 M36 typed-alert dispatcher. */
export interface WorkerAlertPort {
  dispatch(input: {
    alertCode: string;
    severity: string;
    organizationId: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

const FAIL_CLOSED_ORGS: ActiveOrgListPort = {
  async listActiveOrgs() {
    throw new Error(
      "M26 cron: active-org enumerator not bound (fail-closed until the M2 enumerator binds)",
    );
  },
};
const NOOP_ALERTS: WorkerAlertPort = { async dispatch() {} };

export interface M26WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  now?: () => Date;
  readonly activeOrgs?: ActiveOrgListPort;
  readonly alerts?: WorkerAlertPort;
  /** GAP-078 — the `cap:psr-reconcile` worker is only constructed when both are bound (it would otherwise
   *  have no file to read / nowhere to publish `psr_variance_raised`). */
  readonly psrFiles?: PsrFileStorePort;
  readonly outbox?: WriteOutboxPort;
}

/** The `cap:psr-reconcile` job payload — ids only, PHI-free. */
export interface PsrReconcileJobData {
  readonly organizationId: string;
  readonly importId: string;
}

/** Build the Drizzle-backed cron stores over a db handle (exported for the live system-actor suite). */
export function buildStores(db: DbClient): {
  projection: NightlyProjectionStore;
  close: CapYearCloseStore;
  watchdog: PsrWatchdogStore;
} {
  const P = schema.capPeriod;
  const PR = schema.capPsrReconciliation;
  const write = buildDrizzleM26WriteService(db);
  return {
    projection: {
      async listOpenPeriods(orgId) {
        return withOrgContext(db, systemOrgContext(orgId), (tx) =>
          tx
            .select({ id: P.id })
            .from(P)
            .where(or(eq(P.status, "open"), eq(P.status, "active"), eq(P.status, "reopened"))),
        );
      },
      async recompute(orgId, periodId) {
        await write.recompute(sysWriteActor(orgId), periodId);
      },
    },
    close: {
      async listClosablePeriods(orgId, asOf) {
        return withOrgContext(db, systemOrgContext(orgId), (tx) =>
          tx
            .select({ id: P.id })
            .from(P)
            .where(
              and(
                eq(P.status, "active"),
                sql`${P.endsOn} + (${P.graceWindowDays} || ' days')::interval < ${asOf}::date`,
              ),
            ),
        );
      },
      async close(orgId, periodId) {
        await write.closePeriod(sysWriteActor(orgId), periodId);
      },
    },
    watchdog: {
      async staleReconciliationCount(orgId, asOf, staleDays) {
        return withOrgContext(db, systemOrgContext(orgId), async (tx) => {
          const rows = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(PR)
            .where(
              and(
                or(eq(PR.status, "open"), eq(PR.status, "investigating")),
                lte(PR.raisedAt, sql`${asOf}::timestamptz - (${staleDays} || ' days')::interval`),
              ),
            );
          return rows[0]?.n ?? 0;
        });
      },
    },
  };
}

/** Construct the M26 §4.8 cron workers over the injected Valkey connection + db (the M25 worker-runner shape). */
export function registerM26CronWorkers(deps: M26WorkerDeps): Worker[] {
  const now = deps.now ?? (() => new Date());
  const activeOrgs = deps.activeOrgs ?? FAIL_CLOSED_ORGS;
  const alerts = deps.alerts ?? NOOP_ALERTS;
  const stores = buildStores(deps.db);
  const opts = { connection: deps.connection } as const;

  const nightly = new Worker(
    M26_CRON_QUEUES.nightlyProjection,
    async () => {
      for (const { organizationId } of await activeOrgs.listActiveOrgs()) {
        await runNightlyProjection(stores.projection, organizationId);
      }
    },
    { ...opts, concurrency: M26_QUEUE_PARAMS.nightlyProjection.concurrency },
  );

  const close = new Worker(
    M26_CRON_QUEUES.capYearClose,
    async () => {
      const asOf = now().toISOString().slice(0, 10);
      for (const { organizationId } of await activeOrgs.listActiveOrgs()) {
        const { closed } = await runCapYearClose(stores.close, organizationId, asOf);
        if (closed > 0)
          await alerts.dispatch({
            alertCode: "m26.cap.year_close_reminder",
            severity: "warn",
            organizationId,
            payload: { closed },
          });
      }
    },
    { ...opts, concurrency: M26_QUEUE_PARAMS.capYearClose.concurrency },
  );

  const watchdog = new Worker(
    M26_CRON_QUEUES.psrVarianceWatchdog,
    async () => {
      const asOf = now().toISOString();
      for (const { organizationId } of await activeOrgs.listActiveOrgs()) {
        const { stale } = await runPsrVarianceWatchdog(stores.watchdog, organizationId, asOf);
        if (stale > 0)
          await alerts.dispatch({
            alertCode: "m26.cap.psr_variance_detected",
            severity: "warn",
            organizationId,
            payload: { stale },
          });
      }
    },
    { ...opts, concurrency: M26_QUEUE_PARAMS.psrVarianceWatchdog.concurrency },
  );

  const workers = [nightly, close, watchdog];
  if (deps.psrFiles && deps.outbox) {
    const { psrFiles, outbox } = deps;
    workers.push(
      new Worker(
        M26_CRON_QUEUES.psrReconcile,
        async (job) => {
          const { organizationId, importId } = job.data as PsrReconcileJobData;
          await reconcilePsrImport(
            {
              db: deps.db,
              files: psrFiles,
              outbox,
            },
            organizationId,
            importId,
          );
        },
        { ...opts, concurrency: M26_QUEUE_PARAMS.psrReconcile.concurrency },
      ),
    );
  }
  return workers;
}

/**
 * The `cap:psr-reconcile` producer the import route calls after commit. The job id is deterministic per
 * import (no ':' — BullMQ rejects it), so a duplicate enqueue of one import collapses; the finished job is
 * removed so an operator re-trigger (re-upload of a `parse_failed` file) can queue it again.
 */
export function buildPsrReconcileEnqueuer(connection: ConnectionOptions): {
  readonly port: PsrReconcileEnqueuePort;
  readonly queue: Queue;
} {
  const queue = new Queue(M26_CRON_QUEUES.psrReconcile, { connection });
  const { attempts, backoff } = M26_QUEUE_PARAMS.psrReconcile;
  return {
    queue,
    port: {
      async enqueue({ organizationId, importId }) {
        await queue.add("reconcile", { organizationId, importId } satisfies PsrReconcileJobData, {
          jobId: `cap-psr-reconcile-${importId}`,
          attempts,
          backoff,
          removeOnComplete: true,
          removeOnFail: true,
        });
      },
    },
  };
}

/** Register the §4.8 repeatable cron schedules (UTC) on the platform Valkey. Returns the Queues to close. */
export async function scheduleM26Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const nightly = new Queue(M26_CRON_QUEUES.nightlyProjection, { connection });
  const close = new Queue(M26_CRON_QUEUES.capYearClose, { connection });
  const watchdog = new Queue(M26_CRON_QUEUES.psrVarianceWatchdog, { connection });
  await nightly.add(
    "tick",
    {},
    { repeat: { pattern: M26_JOB_SCHEDULES.nightlyProjection, tz: "UTC" } },
  );
  await close.add("tick", {}, { repeat: { pattern: M26_JOB_SCHEDULES.capYearClose, tz: "UTC" } });
  await watchdog.add(
    "tick",
    {},
    { repeat: { pattern: M26_JOB_SCHEDULES.psrVarianceWatchdog, tz: "UTC" } },
  );
  return [nightly, close, watchdog];
}
