// apps/backend/src/modules/11-orders/jobs/verbal-order-expiry-worker.ts — the `orders.verbal_timer`
// BullMQ fan-out for M11's §2.3 D3 / §2.6 / §4.8 verbal-order-signature-deadline sweep (the ONE timer for
// BOTH M11's own `order_record` verbals AND an M12 `medication_order` verbal recorded through the
// OrderSignatureProvider seam — §2.8 D14, the polymorphic `verbal_order` table M12's own spec names this
// design for explicitly: "M12 has no parallel timer").
//
// THE DECISION + WRITE LOGIC IS `OrderRouteService.expireOverdueVerbals` (`../orders-route-service-db.ts` /
// `../routes/service.ts`), NOT this file — this worker is a THIN per-org fan-out over that one service
// method, mirroring `./standing-spawn-worker.ts`'s exact shape (`spawnDueStandingOrders`). Building a
// second, standalone set of Drizzle queries here would duplicate the guard-before-write discipline
// (`planVerbalExpiry`'s NOT_SYSTEM_ACTOR / VERBAL_DEADLINE_NOT_REACHED / ILLEGAL_ORDER_TRANSITION checks),
// the per-candidate transaction isolation (one raced/stale row must not abort the rest of an org's sweep),
// and the exact catalogued `m11.order.verbal_expired_unsigned` payload shape the service method already
// gets right — two places computing the same decision is exactly the shape this codebase's own
// `check-outbox-bindings.ts`/F-101 sweeps exist to catch when it drifts.
import type { ConnectionOptions } from "bullmq";
import { Queue, Worker } from "bullmq";
import type { OrderRouteService } from "../routes/service";
// The same `ActiveOrgListPort` shape `standing-spawn-worker.ts` already declares — imported rather than
// redeclared so `jobs/index.ts`'s `export *` from both siblings does not collide on the name.
import type { ActiveOrgListPort } from "./standing-spawn-worker";

export const M11_VERBAL_TIMER_QUEUE = "orders.verbal_timer";
/** Hourly — the §4.8 cadence `packages/orders/src/lifecycle/verbal-window.ts`'s own header names for this
 *  cron (distinct from the quarter-hourly `orders.verbal_pre_expiry` M36 pre-expiry-alert cron, which is
 *  NOT built here — see this module's CLAUDE.md entry / the handback report for that scoping decision). */
export const M11_VERBAL_TIMER_SCHEDULE = "0 * * * *";
/** The platform job id this fan-out enters `withPlatformContext` under to enumerate active orgs — distinct
 *  from `M11_PLATFORM_JOB_ID` ("m11.standing_spawn"), so each cron's cross-tenant reads audit under its own
 *  name rather than sharing one job's audit trail for two different sweeps. */
export const M11_VERBAL_TIMER_PLATFORM_JOB_ID = "m11.verbal_timer";

export interface VerbalOrderExpiryWorkerDeps {
  readonly connection: ConnectionOptions;
  readonly service: OrderRouteService;
  readonly activeOrgs: ActiveOrgListPort;
}

/** One hourly trigger fans out under the service's per-org `withOrgContext` boundary (the
 *  `runStandingSpawnFanout` shape verbatim) — one org's failure (an unexpected throw escaping the
 *  service method's own per-candidate isolation) does not stop the rest of the fan-out; every org's
 *  error is collected and re-raised together so the worker still surfaces as failed/retried for BullMQ's
 *  own attempt/backoff policy, rather than silently swallowing a whole org's sweep. */
export async function runVerbalOrderExpiryFanout(deps: VerbalOrderExpiryWorkerDeps): Promise<void> {
  const failures: unknown[] = [];
  for (const { organizationId } of await deps.activeOrgs.listActiveOrgs()) {
    try {
      await deps.service.expireOverdueVerbals(organizationId);
    } catch (error) {
      failures.push(error);
    }
    // F-202 (#248) — the same hourly tick lapses pending two-person lab-recovery requests past their 24 h `expires_at`
    // (and raises the compliance alert for each). A separate try so one sweep's failure never skips the other, and
    // riding this timer rather than a new queue keeps the deployment surface unchanged.
    try {
      await deps.service.expireStaleLabRecoveryRequests(organizationId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, `M11_VERBAL_TIMER: ${failures.length} org failure(s)`);
}

export function registerM11VerbalOrderExpiryWorker(deps: VerbalOrderExpiryWorkerDeps): Worker {
  return new Worker(M11_VERBAL_TIMER_QUEUE, async () => runVerbalOrderExpiryFanout(deps), {
    connection: deps.connection,
    concurrency: 1,
  });
}

export async function scheduleM11VerbalOrderExpiry(connection: ConnectionOptions): Promise<Queue> {
  const queue = new Queue(M11_VERBAL_TIMER_QUEUE, { connection });
  await queue.add(
    "hourly",
    {},
    {
      repeat: { pattern: M11_VERBAL_TIMER_SCHEDULE },
      jobId: "m11-verbal-timer-hourly",
      attempts: 3,
      backoff: { type: "exponential", delay: 120_000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
  return queue;
}
