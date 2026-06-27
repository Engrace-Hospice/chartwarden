// apps/backend/src/modules/33-reporting/wiring.ts — M33 Phase-2C LIVE composition glue.
//
// The one place the composition root (apps/backend/src/index.ts) assembles M33's real route
// dependencies, mirroring the M34 wiring.ts precedent:
//   1. the §4.8 `report.mv_refresh` BullMQ producer the MV-admin command routes enqueue onto;
//   2. the Drizzle-backed route services (READ + WRITE + EXPORT/DRILLDOWN) the route plugins mount over;
//   3. the §4.8 platform-job allowlist registration (the cross-org refresh / lag-probe / eraser jobs).
//
// BOUNDARY (M33 dependsOn [1,2,3,4,36] — no new edge): everything cross-module is reached through the
// foundation helpers M1 owns (`@wardenx/tenancy`, `@wardenx/db`) or a PORT this file binds to a typed-TODO
// until the owning infra exposes a boot accessor. Nothing here adds a direct M2/M4/M22/M36 import.
//
// WHAT IS LIVE vs TYPED-TODO (the honest seam map):
//   • LIVE now: the read-replica session (bound over the primary db — M1 transparently fails the replica
//     over to the primary anyway, §8.1.2 — so single-pool dev reads run under the same RLS GUC the writes
//     do), the org-scoped WRITE service (withOrgContext on the primary, fully live), and the §4.8 queue
//     PRODUCER (BullMQ `Queue.add`, when a Valkey connection is configured).
//   • TYPED-TODO (genuinely-missing infra — each FAILS CLOSED, never a silent no-op): the cron-parser
//     adapter (schedule create/update 503s until bound), the M22 render outbox (PDF/XLSX export 503s),
//     the per-tenant DEK encrypt (drilldown audit denies), the M39 consent evaluator (drilldown maximal-
//     narrows), and the tile/export SQL executor (tiles serve the forward-seam empty result). The
//     replica-lag gate reports a healthy single-pool primary (no replica ⇒ no lag).
import type { ConnectionOptions } from "bullmq";
import { Queue } from "bullmq";
import { sql } from "drizzle-orm";

import type { DbClient } from "@wardenx/db";
import {
  type ReadReplicaSessionPort,
  type ReplicaLagGatePort,
  type ReportingDb,
} from "@wardenx/reporting";
import { registerPlatformJob } from "@wardenx/tenancy";

import {
  type CronPort,
  type M33ExportDrilldownRouteService,
  type M33ReadEnqueuePort,
  type M33ReadRouteService,
  type M33WriteRouteService,
  createDrizzleM33ExportDrilldownBackend,
  createDrizzleM33ReadBackend,
  createDrizzleM33WriteBackend,
} from "./routes/index";

/**
 * The registered platform-job id M33's platform-scoped §4.8 workers (the on-PRIMARY MV refresh, the lag
 * probe, the tenant-offboarding eraser) enter `withPlatformContext` under. Registered on the
 * `@wardenx/tenancy` allowlist by {@link wireM33Tenancy} at boot — until then `withPlatformContext` REFUSES
 * the caller (fail-closed; the allowlist starts empty). The M34 `M34_PLATFORM_JOB_ID` precedent.
 */
export const M33_PLATFORM_JOB_ID = "m33.platform_ops";

/** Raised by a still-unbound Phase-2C infra port (the fail-closed signal — never a silent no-op). */
export class M33InfraPortUnbound extends Error {
  constructor(port: string, reason: string) {
    super(`M33 Phase-2C infra port '${port}' is not bound to a real adapter: ${reason}`);
    this.name = "M33InfraPortUnbound";
  }
}

// ── tenancy allowlist registration (must run before any withPlatformContext entry) ────────────────────

/**
 * Register M33's platform job id on the `@wardenx/tenancy` PLATFORM_CONTEXT_ALLOWLIST so the §4.8
 * platform-scoped workers (the MV refresh on the PRIMARY, the lag probe, the tenant eraser) may enter
 * `withPlatformContext` (the allowlist starts empty — fail-closed). Idempotent (`Set.add`). The M34
 * `wireM34Tenancy` precedent.
 */
export function wireM33Tenancy(): void {
  registerPlatformJob(M33_PLATFORM_JOB_ID);
}

// ── (1) the §4.8 read-side queue producer (the MV-admin command routes enqueue onto this) ─────────────

/**
 * Build the `report.mv_refresh` `M33ReadEnqueuePort` the §4.1 MV-admin command routes call. When a Valkey
 * connection is configured it produces onto the named BullMQ `Queue` (jobId-deduped); without one it fails
 * closed (an MV-refresh command cannot silently drop its enqueue). Returns the `Queue`s for `close()`.
 * Mirrors the M34 `buildPlatformEnqueue` producer.
 */
export function buildM33ReadEnqueue(connection: ConnectionOptions | undefined): {
  enqueue: M33ReadEnqueuePort;
  queues: Queue[];
} {
  if (!connection) {
    return {
      enqueue: {
        async enqueue(queue) {
          throw new M33InfraPortUnbound(
            "readEnqueue",
            `no Valkey connection configured — cannot enqueue '${queue}' (set the queue connection at boot)`,
          );
        },
      },
      queues: [],
    };
  }
  const cache = new Map<string, Queue>();
  const queueFor = (name: string): Queue => {
    let q = cache.get(name);
    if (!q) {
      q = new Queue(name, { connection });
      cache.set(name, q);
    }
    return q;
  };
  const enqueue: M33ReadEnqueuePort = {
    async enqueue(queue, jobKey, payload) {
      const job = await queueFor(queue).add(queue, payload, {
        jobId: `${queue}:${jobKey}`,
        removeOnComplete: { count: 500 },
        removeOnFail: false,
      });
      return { jobId: job.id ?? `${queue}:${jobKey}` };
    },
  };
  return { enqueue, queues: [...cache.values()] };
}

// ── shared infra ports (the live replica-over-primary session + the healthy single-pool lag gate) ─────

/**
 * Bind the M1 `read_replica_session` port (§8.1.2) over the primary Drizzle client. The architecture has
 * M1 transparently fail the replica over to the primary on replica down/lag (M02 §8.1.2), so in a
 * single-pool dev/local boot a read legitimately runs on the primary under the SAME three `SET LOCAL` GUCs
 * the replica path applies: the `app.org_id` RLS scope (without it every RLS-bound query returns zero rows
 * — D3 fail-closed), `default_transaction_read_only = TRUE` (defence in depth), and the tier
 * `statement_timeout`. When M1 exposes a dedicated read-replica pool accessor, swap it in here.
 */
function buildLiveReplicaSession(db: DbClient): ReadReplicaSessionPort {
  return {
    withSession(req, fn) {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.org_id', ${req.orgId}, true)`);
        await tx.execute(sql`SET LOCAL default_transaction_read_only = TRUE`);
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${String(req.statementTimeoutMs)}, true)`,
        );
        return fn(tx as unknown as ReportingDb);
      });
    },
  };
}

/**
 * The single-pool lag gate: a primary-only boot has no replica and therefore no replay lag (the D14
 * breaker never trips). Reports `lagSeconds: 0, breakerOpen: false` so reads serve the primary directly.
 * Replaced by the Valkey-backed `report.lag_probe` hysteresis state when a real read replica is provisioned.
 */
const HEALTHY_SINGLE_POOL_LAG_GATE: ReplicaLagGatePort = {
  async read() {
    return { lagSeconds: 0, breakerOpen: false };
  },
};

/**
 * The fail-closed cron port (typed-TODO). The schedule create/update/resume routes compute `next_run_at`
 * through this; until the `cron-parser`-over-IANA-TZ adapter is wired they DENY (a 5xx), never persist a
 * schedule with a fabricated fire time. The rest of the WRITE surface (definitions / views / non-cron
 * schedule ops) is fully live.
 */
const FAIL_CLOSED_CRON: CronPort = {
  nextRunAfter() {
    throw new M33InfraPortUnbound(
      "cron.nextRunAfter",
      "bind the cron-parser-over-IANA-TZ adapter (no cron seam wired yet) — schedule create/update denies until bound",
    );
  },
};

// ── (2) the Drizzle-backed route services (READ + WRITE + EXPORT/DRILLDOWN) ───────────────────────────

/**
 * Build the production READ route service (§4.1 #1–#7, #37–#42) over the read-replica-over-primary
 * session. Tile/metric/dashboard reads run under `withReportSession` (RLS-scoped, read-only, tiered
 * statement_timeout); the MV-admin commands enqueue the on-PRIMARY `report.mv_refresh` job through the
 * injected producer. The dashboard/metrics/tile SQL executor ports are unbound (deny-stub-safe → the
 * forward-seam empty tile, never fabricated rows — D6).
 */
export function buildDrizzleM33ReadService(deps: {
  db: DbClient;
  enqueue: M33ReadEnqueuePort;
}): { service: M33ReadRouteService } {
  return createDrizzleM33ReadBackend({
    replica: buildLiveReplicaSession(deps.db),
    lag: HEALTHY_SINGLE_POOL_LAG_GATE,
    enqueue: deps.enqueue,
  });
}

/**
 * Build the production WRITE route service (§4.1 #8–#31: definitions / views / shares / schedules) over the
 * org-pooled primary Drizzle client. EVERY method runs inside the tenant's own `withOrgContext` (RLS scopes
 * each statement to `app.org_id`) — fully live, EXCEPT the cron math (fail-closed typed-TODO) and the
 * best-effort `m33.*` outbox emit (omitted until the live dispatcher binds).
 */
export function buildDrizzleM33WriteService(deps: { db: DbClient }): {
  service: M33WriteRouteService;
} {
  return createDrizzleM33WriteBackend({
    db: deps.db,
    cron: FAIL_CLOSED_CRON,
    now: () => new Date(),
  });
}

/**
 * Build the production EXPORT + DRILLDOWN route service (§4.1 #32–#36) over the read-replica-over-primary
 * session (the drilldown audit append writes under its own `withOrgContext` on the primary). Deny-stub-safe:
 * the M22 render outbox (PDF/XLSX → 503 ExportRenderUnbound), the per-tenant DEK encrypt (drilldown →
 * DrilldownDekUnavailable deny), the M39 consent evaluator (maximal-narrow), and the export SQL executor
 * (header-only CSV) are all unbound — each fails closed / forward-seams, never fails open (D6/D13/§3.6).
 */
export function buildDrizzleM33ExportDrilldownService(deps: { db: DbClient }): {
  service: M33ExportDrilldownRouteService;
} {
  return createDrizzleM33ExportDrilldownBackend({
    db: deps.db,
    replica: buildLiveReplicaSession(deps.db),
    lag: HEALTHY_SINGLE_POOL_LAG_GATE,
  });
}
