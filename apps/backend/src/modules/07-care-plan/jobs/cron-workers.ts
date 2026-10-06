// apps/backend/src/modules/07-care-plan/jobs/cron-workers.ts — TASK-040D: the LIVE BullMQ Worker +
// repeatable Queue for the §4.6 `care-plan.gates` daily cron (the M25 `25-remittance/jobs/cron-workers.ts`
// template, verbatim in shape). ONE queue, ONE schedule (`M7_JOB_SCHEDULES.gates`), ONE worker — M7 has
// no second cron. Each tick fans out over the active orgs, opens ONE per-org `withOrgContext` tx, reads
// the org's gate snapshots (`./cron-store`), runs BOTH pure scans from `./index`
// (`planInitialGateScan` + `planReviewGateScan` — both fire off the single daily `gates` schedule),
// publishes every planned event to the TRANSACTIONAL OUTBOX, and flips the emission markers — all inside
// the SAME tx, so a thrown outbox validation error rolls back the whole org's tick (retry-the-whole-org-
// next-tick over half-applying is the correct failure mode here). `idg`/`snapshot` (M7_QUEUES) are OUT OF
// SCOPE — event-driven consumers are handled outside BullMQ; this file touches only `M7_QUEUES.gates`.
//
// Unlike M25's `alerts`/`activeOrgs` (both lazy fail-closed until bound), `outbox` here is NOT optional —
// the composition root constructs it unconditionally whenever a DB client exists, so by the time a cron
// tick runs it is guaranteed bound. Only `activeOrgs` gets the lazy fail-closed thunk (`unbound()`,
// `M7_WORKER_PORT_UNBOUND: <port> — <hint>`, the M25 convention).
import type { DbClient } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import {
  applyReviewGateMarkers,
  carePlanGateSnapshotsForOrg,
  markInitialWarningEmitted,
} from "./cron-store";
import {
  M7_JOB_SCHEDULES,
  M7_QUEUES,
  M7_QUEUE_PARAMS,
  planInitialGateScan,
  planReviewGateScan,
} from "./index";

/**
 * The transactional-outbox publish port the composition root binds (the `OutboxPublishPort` shape from
 * `apps/backend/src/bootstrap/outbox-persister.ts`, restated locally so this module takes no bootstrap
 * import edge). `tx` is the SAME `DbClient`-shaped handle the caller's `withOrgContext` callback hands
 * in — the publish and the marker-column update below run in that one tx, atomically.
 */
export interface CarePlanOutboxPublishPort {
  publish(
    tx: DbClient,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The M2 active-org enumerator the cron fan-out reads (runs under withPlatformContext when bound). */
export interface ActiveOrgListPort {
  listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
}

/** The dep bag the composition root injects. `outbox` is REQUIRED; `activeOrgs` defaults fail-closed. */
export interface M7WorkerDeps {
  readonly connection: ConnectionOptions;
  readonly db: DbClient;
  readonly outbox: CarePlanOutboxPublishPort;
  readonly activeOrgs?: ActiveOrgListPort;
  now?: () => Date;
}

/** A fail-closed port: throws a descriptive UNBOUND error when a cron tick reaches an unbound dependency. */
function unbound<T>(port: string, hint: string): Promise<T> {
  return Promise.reject(new Error(`M7_WORKER_PORT_UNBOUND: ${port} — ${hint}`));
}

function activeOrgsOf(deps: M7WorkerDeps): ActiveOrgListPort {
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

/** Build the {@link M7WorkerDeps} from the composition-root primitives (the M25 `buildM25WorkerDeps` shape). */
export function buildM7WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  outbox: CarePlanOutboxPublishPort;
  activeOrgs?: ActiveOrgListPort;
}): M7WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    outbox: deps.outbox,
    activeOrgs: deps.activeOrgs,
    now: () => new Date(),
  };
}

// ── the per-org cron runner (fan out over active orgs, RLS-scoped, outbox-publishing) ─────────────────

/**
 * `care-plan.gates` (§4.6, §7.1/§7.2) — the daily scan that runs BOTH `planInitialGateScan` and
 * `planReviewGateScan` per org (one schedule, two gates), publishes every planned event to the outbox,
 * and flips the idempotency markers those pure functions gate on — all inside one per-org tx.
 */
export async function runCarePlanGatesCron(deps: M7WorkerDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const orgs = await activeOrgsOf(deps).listActiveOrgs();
  for (const { organizationId } of orgs) {
    await withOrgContext(deps.db, systemOrgContext(organizationId), async (tx) => {
      const t = tx as unknown as DbClient;
      const snapshots = await carePlanGateSnapshotsForOrg(t, organizationId);
      const initialPlan = planInitialGateScan(snapshots, now);
      const reviewPlan = planReviewGateScan(snapshots, now);
      for (const event of [...initialPlan.events, ...reviewPlan.events]) {
        await deps.outbox.publish(t, {
          eventName: event.eventName,
          payload: event.payload,
          organizationId,
          aggregateKind: "care_plan",
          aggregateId: String(event.payload.planId),
        });
      }
      await markInitialWarningEmitted(t, initialPlan.markedPlanIds);
      await applyReviewGateMarkers(t, reviewPlan.events);
    });
  }
}

// ── BullMQ construction (the M25 registerM25CronWorkers / scheduleM25Jobs template) ────────────────────

/** Construct the ONE `care-plan.gates` `Worker` (the caller owns lifecycle — `close()` on shutdown). */
export function registerM7CronWorkers(deps: M7WorkerDeps): Worker[] {
  const { connection } = deps;
  return [
    new Worker(M7_QUEUES.gates, async () => runCarePlanGatesCron(deps), {
      connection,
      concurrency: M7_QUEUE_PARAMS.gates.concurrency,
    }),
  ];
}

/**
 * Register the §4.6 repeatable `care-plan.gates` schedule. Threads the FULL `M7_QUEUE_PARAMS.gates`
 * envelope (priority/attempts/backoff/removeOnComplete/removeOnFail) so the already-declared param
 * catalog governs the real repeatable job, not just documents it. No separate DLQ `Queue` is
 * constructed — `removeOnFail:false` keeps the main queue's own failed-jobs set as the de facto DLQ
 * (no module in this codebase constructs `M7_DLQ.gates` as a literal `Queue`); DLQ-promotion alerting
 * attaches externally to the returned `Worker`, outside this file's scope. Returns the `Queue` to `close()`.
 */
export async function scheduleM7Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const queue = new Queue(M7_QUEUES.gates, { connection });
  await queue.add(
    "scheduled",
    {},
    {
      repeat: { pattern: M7_JOB_SCHEDULES.gates },
      priority: M7_QUEUE_PARAMS.gates.priority,
      attempts: M7_QUEUE_PARAMS.gates.attempts,
      backoff: M7_QUEUE_PARAMS.gates.backoff,
      removeOnComplete: M7_QUEUE_PARAMS.gates.removeOnComplete,
      removeOnFail: M7_QUEUE_PARAMS.gates.removeOnFail,
    },
  );
  return [queue];
}
