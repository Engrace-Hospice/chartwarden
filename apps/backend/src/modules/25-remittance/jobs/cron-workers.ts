// apps/backend/src/modules/25-remittance/jobs/cron-workers.ts — the M25 §4.8 BullMQ cron worker
// construction (the M27 m27-jobs.ts template). Two nightly crons fan out over the active orgs, open the
// per-org `withOrgContext` RLS envelope, run the PURE handlers (runDenialAging / runAppealDeadlineWatch from
// ./m25-jobs), and dispatch the §4.9 M36 alerts. The cross-module/platform ports (the M2 active-org
// enumerator, the M36 alert router, the transactional outbox) carry a LAZY fail-closed thunk default until
// the integrator binds them — so constructing the workers at boot stays green; a port only throws WHEN A
// CRON TICK RUNS (never at import). Nothing here runs at import (constructing a Worker opens Valkey).
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import {
  type AppealDeadlineStore,
  type DenialAgingStore,
  runAppealDeadlineWatch,
  runDenialAging,
} from "./m25-jobs";
import { M25_CRON_QUEUES, type M25CronQueueName, M25_JOB_SCHEDULES, M25_QUEUE_PARAMS } from "./queues";

/** The system actor id the cron stamps on its per-org `withOrgContext` reads (audit attribution). */
const M25_WORKER_SYSTEM_USER_ID = "00000000-0000-0000-0000-0000000000e5";

/** The §4.9 M36 typed-alert dispatcher (alerts ship as defs + fire through M36). */
export interface WorkerAlertPort {
  dispatch(input: {
    readonly alertCode: string;
    readonly severity: string;
    readonly organizationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void>;
}

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The dep bag the composition root injects. The platform ports default to a fail-closed thunk until bound. */
export interface M25WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  now?: () => Date;
  readonly alerts?: WorkerAlertPort;
  readonly activeOrgs?: ActiveOrgListPort;
}

/** A fail-closed port: throws a descriptive UNBOUND error when a cron tick reaches an unbound dependency. */
function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M25_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

function activeOrgsOf(deps: M25WorkerDeps): ActiveOrgListPort {
  return (
    deps.activeOrgs ?? {
      listActiveOrgs: () =>
        unbound(
          "activeOrgs.listActiveOrgs",
          "bind the M2 active-org enumerator (the cron fan-out source) under withPlatformContext",
        ),
    }
  );
}

function alertsOf(deps: M25WorkerDeps): WorkerAlertPort {
  return (
    deps.alerts ?? {
      dispatch: () => unbound("alerts.dispatch", "bind the M36 alert router (the §4.9 typed-alert sink)"),
    }
  );
}

/** Build the {@link M25WorkerDeps} from the composition-root primitives (the M27 buildM27WorkerDeps shape). */
export function buildM25WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  alerts?: WorkerAlertPort;
  activeOrgs?: ActiveOrgListPort;
}): M25WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    alerts: deps.alerts,
    activeOrgs: deps.activeOrgs,
    now: () => new Date(),
  };
}

// ── the per-org cron runners (fan out over active orgs, RLS-scoped, alert-dispatching) ────────────────────

/** Nightly: rebucket every open denial's aging + dispatch the 30/90-day threshold alerts (§2.4). */
export async function runDenialAgingCron(deps: M25WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const alerts = alertsOf(deps);
  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: M25_WORKER_SYSTEM_USER_ID }, async (tx) => {
      const DC = schema.denialCase;
      const store: DenialAgingStore = {
        async openCases() {
          const rows = await tx
            .select({ id: DC.id, openedAt: DC.openedAt, currentBucketDays: DC.agingBucketDays, state: DC.state })
            .from(DC)
            .where(sql`${DC.state} IN ('open','in_progress','escalated')`)
            .limit(100000);
          return rows.map((r) => ({
            id: r.id,
            openedAt: r.openedAt instanceof Date ? r.openedAt.toISOString() : String(r.openedAt),
            currentBucketDays: r.currentBucketDays,
            state: r.state,
          }));
        },
        async setAgingBucketDays(denialCaseId, days) {
          await tx.update(DC).set({ agingBucketDays: days }).where(eq(DC.id, denialCaseId));
        },
      };
      const result = await runDenialAging(store, now);
      for (const a of result.alerts) {
        await alerts.dispatch({
          alertCode: a.kind,
          severity: a.kind === "denial.high_value" ? "high" : "warn",
          organizationId,
          payload: a.detail,
        });
      }
    });
  }
}

/** Nightly: emit the T-30/14/7/1 appeal-deadline alerts at each appeal's tightest boundary (§2.4 / D6). */
export async function runAppealDeadlineCron(deps: M25WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  const alerts = alertsOf(deps);
  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, { organizationId, userId: M25_WORKER_SYSTEM_USER_ID }, async (tx) => {
      const AC = schema.appealCase;
      const store: AppealDeadlineStore = {
        async watchableAppeals() {
          const rows = await tx
            .select({ id: AC.id, tierDeadlineAt: AC.tierDeadlineAt, state: AC.state })
            .from(AC)
            .where(sql`${AC.state} IN ('draft','submitted','under_review')`)
            .limit(100000);
          return rows.map((r) => ({
            id: r.id,
            tierDeadlineAt: r.tierDeadlineAt instanceof Date ? r.tierDeadlineAt.toISOString() : String(r.tierDeadlineAt),
            state: r.state,
          }));
        },
      };
      const result = await runAppealDeadlineWatch(store, now);
      for (const a of result.alerts) {
        await alerts.dispatch({
          alertCode: a.kind,
          severity: "warn",
          organizationId,
          payload: a.detail,
        });
      }
    });
  }
}

// ── BullMQ construction (the M27 registerM27CronWorkers / scheduleM27Jobs template) ───────────────────────

/** Construct one BullMQ `Worker` per §4.8 cron queue. The caller owns lifecycle (`close()` on shutdown). */
export function registerM25CronWorkers(deps: M25WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(M25_CRON_QUEUES.denialAgingScan, async () => runDenialAgingCron(deps), {
      connection,
      concurrency: M25_QUEUE_PARAMS.denialAgingScan.concurrency,
    }),
    new Worker(M25_CRON_QUEUES.appealDeadlineScan, async () => runAppealDeadlineCron(deps), {
      connection,
      concurrency: M25_QUEUE_PARAMS.appealDeadlineScan.concurrency,
    }),
  ];
}

/** Register the §4.8 repeatable cron schedules on their dedicated queues. Returns the `Queue`s to `close()`. */
export async function scheduleM25Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const schedules: readonly [M25CronQueueName, string][] = [
    [M25_CRON_QUEUES.denialAgingScan, M25_JOB_SCHEDULES.denialAgingScan],
    [M25_CRON_QUEUES.appealDeadlineScan, M25_JOB_SCHEDULES.appealDeadlineScan],
  ];
  const queues: Queue[] = [];
  for (const [name, pattern] of schedules) {
    const queue = new Queue(name, { connection });
    await queue.add("scheduled", {}, { repeat: { pattern }, removeOnComplete: true });
    queues.push(queue);
  }
  return queues;
}
