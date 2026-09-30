// apps/backend/src/modules/19-oncall/jobs/worker.ts — the §4.8 `m19.shift-sync.debounced` drain worker +
// the "shift cron tick" catch-up-seed worker (m19 `handlers-unbound` group, #248; F-155's own finding,
// now built). The `M11_STANDING_SPAWN_QUEUE`/M12 `dosespot_sync_queue` shape: fan out over active orgs,
// claim, process outside the claiming transaction where the work can be slow, one org's failure never
// aborts the rest of the tick (`AggregateError` at the end).
//
// TWO BULLMQ WORKERS, ONE POSTGRES TABLE — see `./index.ts`'s header for why the catch-up seeder does not
// reconcile directly. `runOnCallRosterSyncDrainTick` is the ONLY code path that ever calls
// `reconcileOrgOnCallRoster` in production.
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { IsoInstant } from "@wardenx/types";
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import {
  M19_JOB_SCHEDULES,
  M19_QUEUE_PARAMS,
  M19_QUEUES,
  M19_ROSTER_SYNC_CATCHUP_JOB_NAME,
  M19_ROSTER_SYNC_DRAIN_JOB_NAME,
} from "./index";
import type { OrgRosterReadPort } from "./reconcile";
import { reconcileOrgOnCallRoster } from "./reconcile";
import { OnCallRosterSyncQueueRepository } from "./repository";

/** §3.3 — a worker-driven roster sync names no acting membership (the M12/M20 `CONSUMER_USER_ID`
 *  convention, restated locally per this directory's own files). */
const M19_WORKER_USER_ID = "";

/** A single drain tick claims and processes at most this many rows per org, per tick — a backlog beyond
 *  that (which should not occur: at most one `pending` row per org exists at a time barring the one
 *  documented race in `../repository.ts`'s `triggerDebounce` doc comment) is left for the NEXT tick
 *  10 seconds later rather than letting one org monopolize a shared worker process. */
const MAX_CLAIMS_PER_ORG_PER_TICK = 10;

export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

export interface M19WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly activeOrgs: ActiveOrgListPort;
  /** Defaults to the real `readOnCallRoster` seam read — see `./reconcile.ts`'s header for why this stays
   *  injectable (M17's own seam is today a permanent, documented deny-stub). */
  readonly rosterReader?: OrgRosterReadPort;
  now?: () => Date;
}

/** Claim and reconcile every currently-due row for one org, looping until none remain (capped). Each
 *  claimed row's reconciliation is its OWN failure domain: a reconciliation error marks that row `failed`
 *  and re-throws so the caller's `AggregateError` records it, but does not stop this org's OWN further
 *  claims within the same tick, since a second pending row (the documented mid-drain race) is an
 *  independent unit of work. */
async function drainOneOrg(
  deps: M19WorkerDeps,
  organizationId: string,
  now: Date,
  log: (msg: string, meta: Record<string, unknown>) => void,
): Promise<void> {
  const failures: unknown[] = [];
  for (let i = 0; i < MAX_CLAIMS_PER_ORG_PER_TICK; i++) {
    const claimed = await withOrgContext(
      deps.db,
      { organizationId, userId: M19_WORKER_USER_ID },
      async (handle) => {
        const repo = new OnCallRosterSyncQueueRepository(handle as DbClient);
        return repo.claimDueForOrg(organizationId, now);
      },
    );
    if (!claimed) return;

    try {
      const result = await reconcileOrgOnCallRoster(
        deps.db,
        organizationId,
        now.toISOString() as IsoInstant,
        now,
        deps.rosterReader,
      );
      await withOrgContext(deps.db, { organizationId, userId: M19_WORKER_USER_ID }, (handle) => {
        const repo = new OnCallRosterSyncQueueRepository(handle as DbClient);
        return repo.markCompleted(claimed.id, now);
      });
      log("m19.shift-sync.debounced: reconciled", {
        organizationId,
        reason: claimed.reason,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withOrgContext(deps.db, { organizationId, userId: M19_WORKER_USER_ID }, (handle) => {
        const repo = new OnCallRosterSyncQueueRepository(handle as DbClient);
        return repo.markFailed(claimed.id, message, now);
      });
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `M19_ROSTER_SYNC_DRAIN: ${failures.length} failure(s) for org ${organizationId}`);
}

/** §4.8 `m19.shift-sync.debounced` — fan out over every active org and drain its due rows. */
export async function runOnCallRosterSyncDrainTick(deps: M19WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const log = (msg: string, meta: Record<string, unknown>): void => {
    // eslint-disable-next-line no-console -- cron workers in this codebase log via console (M9's own
    // `runReassessmentDueCron` / M20's `runSosSlaWatchdogCron` precedent).
    console.log(msg, meta);
  };
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      await drainOneOrg(deps, organizationId, now, log);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `M19_ROSTER_SYNC_DRAIN: ${failures.length} org failure(s)`);
}

/** The §4.5 "shift cron tick" catch-up trigger — seeds a `cron_catchup` row for every active org that has
 *  no debounce currently in flight. Never reconciles directly (see this file's header). */
export async function runOnCallRosterSyncCatchupTick(deps: M19WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      await withOrgContext(deps.db, { organizationId, userId: M19_WORKER_USER_ID }, (handle) => {
        const repo = new OnCallRosterSyncQueueRepository(handle as DbClient);
        return repo.ensureCatchUpPending({ organizationId, now });
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `M19_ROSTER_SYNC_CATCHUP: ${failures.length} org failure(s)`);
}

// ── BullMQ construction (the M9/M12/M20/M25 registerMxCronWorkers / scheduleMxJobs template) ────────────

/** Construct the two live `Worker`s (the caller owns lifecycle — `close()` on shutdown). */
export function registerM19CronWorkers(deps: M19WorkerDeps): Worker[] {
  return [
    new Worker(M19_QUEUES.rosterSyncDrain, async () => runOnCallRosterSyncDrainTick(deps), {
      connection: deps.connection,
      concurrency: M19_QUEUE_PARAMS.rosterSyncDrain.concurrency,
    }),
    new Worker(M19_QUEUES.rosterSyncCatchup, async () => runOnCallRosterSyncCatchupTick(deps), {
      connection: deps.connection,
      concurrency: M19_QUEUE_PARAMS.rosterSyncCatchup.concurrency,
    }),
  ];
}

function parseBackoff(spec: string): { type: "exponential" | "fixed"; delay: number } {
  const [type, duration] = spec.trim().split(/\s+/);
  const m = /^(\d+)(ms|s|m|h)$/.exec(duration ?? "");
  if ((type !== "exponential" && type !== "fixed") || !m) {
    throw new Error(`M19_BACKOFF_PARSE: unrecognized backoff '${spec}'`);
  }
  const n = Number(m[1]);
  const unit = m[2];
  const delay = unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
  return { type, delay };
}

/** Register the repeatable schedules — `every` (ms), not a cron `pattern` (the M20/M33 `lagProbeEveryMs`
 *  convention for a sub-hour cadence). Returns both `Queue`s so the composition root can `close()` them. */
export async function scheduleM19Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const drainQueue = new Queue(M19_QUEUES.rosterSyncDrain, { connection });
  const drainParams = M19_QUEUE_PARAMS.rosterSyncDrain;
  await drainQueue.add(
    M19_ROSTER_SYNC_DRAIN_JOB_NAME,
    {},
    {
      repeat: { every: M19_JOB_SCHEDULES.rosterSyncDrainEveryMs },
      priority: drainParams.priority,
      attempts: drainParams.attempts,
      backoff: parseBackoff(drainParams.backoff),
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  const catchupQueue = new Queue(M19_QUEUES.rosterSyncCatchup, { connection });
  const catchupParams = M19_QUEUE_PARAMS.rosterSyncCatchup;
  await catchupQueue.add(
    M19_ROSTER_SYNC_CATCHUP_JOB_NAME,
    {},
    {
      repeat: { every: M19_JOB_SCHEDULES.rosterSyncCatchupEveryMs },
      priority: catchupParams.priority,
      attempts: catchupParams.attempts,
      backoff: parseBackoff(catchupParams.backoff),
      removeOnComplete: true,
      removeOnFail: false,
    },
  );

  return [drainQueue, catchupQueue];
}
