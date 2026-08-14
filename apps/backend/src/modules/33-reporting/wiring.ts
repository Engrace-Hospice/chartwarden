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
//     do), the org-scoped WRITE service (withOrgContext on the primary, fully live), the §4.8 queue
//     PRODUCER (BullMQ `Queue.add`, when a Valkey connection is configured), and the `cron-parser`-over-
//     IANA-TZ adapter (GAP-050 — schedule create/update/resume compute a real `next_run_at`).
//   • TYPED-TODO (genuinely-missing infra — each FAILS CLOSED, never a silent no-op): the M22 render
//     outbox (PDF/XLSX export 503s), the per-tenant DEK encrypt (drilldown audit denies), the M39 consent
//     evaluator (drilldown maximal-narrows), and the tile/export SQL executor (tiles serve the
//     forward-seam empty result). The replica-lag gate reports a healthy single-pool primary (no replica
//     ⇒ no lag).
import type { ConnectionOptions } from "bullmq";
import { Queue } from "bullmq";
import { parseExpression } from "cron-parser";
import { sql } from "drizzle-orm";

import type { DbClient } from "@wardenx/db";
import {
  type CsvExportOutboxPort,
  type DrilldownAuditOutboxPort,
  MetricsProviderImpl,
  type ReadReplicaSessionPort,
  type ReplicaLagGatePort,
  type ReportingConsentConsumer,
  type ReportingDb,
} from "@wardenx/reporting";
import { isValidTimeZone } from "@wardenx/shared/dates";
import { registerPlatformJob } from "@wardenx/tenancy";

import { getSeam, registerSeam } from "../../bootstrap/index";
import {
  CronExpressionInvalidError,
  type CronPort,
  type ExportSqlExecutor,
  type M33ExportDrilldownRouteService,
  type M33ReadEnqueuePort,
  type M33ReadRouteService,
  type M33WriteRouteService,
  type TileSqlExecutor,
  type WriteOutboxPort,
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
 * Register M33's PUBLISHED `MetricsProvider` seam (#107 item 2 / §4.3) into the M1 SeamRegistry — the embedded
 * dashboard-metric read M30/M34/M37 resolve via `getSeam`. With NO MV executor bound it returns the forward-
 * seam EMPTY value (`value: null`, `isForwardSeamDenyStub: true`) over the authoritative unit from
 * `report_metric_catalog` — never a fabricated number; the real value lands when M33's MV read path binds. The
 * read runs under the replica-over-primary session (RLS-scoped to the caller's org). When no db is present the
 * M1 fail-closed deny-stub stands. Called by the composition root in `wireModuleSeams` (the M10
 * `registerHopeSeams` precedent).
 */
export function registerReportingMetricsSeam(db: DbClient | undefined): void {
  if (!db) return;
  registerSeam(
    "MetricsProvider",
    new MetricsProviderImpl({ replica: buildLiveReplicaSession(db) }),
  );
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
 * The LIVE `cron-parser`-over-IANA-TZ adapter (GAP-050). The schedule create/update/resume routes compute
 * `next_run_at` through this; it was a fail-closed stub, so all three permanently 5xx'd and no tenant could
 * ever create a scheduled report — the §4.8 scheduled-run cron had nothing to fire.
 *
 * `cron-parser` evaluates the expression IN the tenant's own IANA zone (`tz`), which is the whole point of
 * storing `report_schedule.tenant_timezone`: "every weekday at 09:00" must mean 09:00 where the hospice
 * operates, and must keep meaning that across a DST transition (the UTC instant moves by an hour; the wall
 * clock does not). `currentDate: after` makes each call return the first fire STRICTLY after `after`, which
 * is what `cronFires` relies on to derive the second fire for the §2.3 cadence floor.
 *
 * TWO refusals `cron-parser` will NOT make for us, both of which must be caught here rather than persisted:
 *
 *  1. **A BLANK expression parses as `* * * * *`.** `parseExpression("")` and `parseExpression("   ")` both
 *     return a valid every-minute schedule rather than throwing. On create/update the §2.3 cadence floor
 *     happens to reject that (a 1-minute gap < 5 minutes → CRON_TOO_FREQUENT), but `resumeSchedule` only
 *     computes the FIRST fire and never asserts cadence — so a blank expression would resume as a
 *     once-a-minute report. Rejected explicitly, at the one place both paths funnel through.
 *  2. **An unrecognized timezone fails deep inside the evaluator**, as `CronDate: unhandled timestamp:
 *     null` — a message that tells a tenant admin nothing. `isValidTimeZone` (@wardenx/shared/dates, the
 *     PARAM-004 helper) is checked first so the 422 names the actual problem.
 *
 * Everything else (out-of-range fields, malformed syntax, an expression with no future occurrence such as
 * `0 9 30 2 *`) throws inside `parseExpression`/`next()` and is wrapped with its own message intact.
 */
export const LIVE_CRON: CronPort = {
  nextRunAfter(cronExpression, tenantTimezone, after) {
    if (cronExpression.trim().length === 0) {
      throw new CronExpressionInvalidError(
        "the expression is blank (a blank cron parses as '* * * * *' — every minute — rather than failing)",
      );
    }
    if (!isValidTimeZone(tenantTimezone)) {
      throw new CronExpressionInvalidError(
        `'${tenantTimezone}' is not an IANA timezone Intl recognizes`,
      );
    }
    try {
      return parseExpression(cronExpression, {
        currentDate: after,
        tz: tenantTimezone,
      })
        .next()
        .toDate();
    } catch (cause) {
      throw new CronExpressionInvalidError(
        `'${cronExpression}' in '${tenantTimezone}': ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  },
};

// ── (2) the Drizzle-backed route services (READ + WRITE + EXPORT/DRILLDOWN) ───────────────────────────

/**
 * Reconstruct `translateSpec`'s parameterized SQL text (literal `$1, $2, … $n` placeholders + a matching
 * `params` array, kept SEPARATE by design — D4, no raw-SQL/string-interpolated values) as a real
 * drizzle-orm `SQL` object `db.execute` can run. drizzle-orm's public API has no "text + params array"
 * constructor (`sql.raw(str)` is TEXT-ONLY, no param binding), so this splits the text on its `$<n>`
 * markers and rebuilds the query as a `sql.join` of alternating raw-text `sql.raw()` chunks and bound
 * `` sql`${value}` `` param chunks, in the SAME left-to-right order the text already encodes — drizzle then
 * re-numbers those chunks into `$1, $2, …` on render, which is identical to the input numbering because the
 * chunk order matches it exactly. Every bound value still passes through drizzle's own parameter binding
 * (a real `pg` driver parameter, never string-interpolated) — this is a re-encoding of the SAME
 * already-safe parameterized query, not a new SQL-construction surface.
 */
function toParameterizedSql(text: string, params: readonly unknown[]) {
  const parts = text.split(/\$(\d+)/);
  const chunks: ReturnType<typeof sql.raw>[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined) continue;
    if (i % 2 === 0) {
      if (part.length > 0) chunks.push(sql.raw(part));
    } else {
      const value = params[Number(part) - 1];
      chunks.push(sql`${value}`);
    }
  }
  return sql.join(chunks);
}

/**
 * The real Drizzle-backed {@link TileSqlExecutor} / {@link ExportSqlExecutor} — executes a `translateSpec`
 * result on the CALLER-SUPPLIED `db` (the active `withReportSession` tx), never a statically-captured
 * connection (see both interfaces' doc comments for why that would silently defeat RLS). Shared by the READ
 * service's tile reads and the EXPORT service's CSV stream / row-count paths — one executor, two ports with
 * the same shape.
 */
function buildDrizzleTileSqlExecutor(): TileSqlExecutor & ExportSqlExecutor {
  return {
    async execute(db, { sql: text, params }) {
      const result = await db.execute(toParameterizedSql(text, params));
      const rows = result.rows;
      return { rows, rowCount: result.rowCount ?? rows.length };
    },
  };
}

/**
 * Build the production READ route service (§4.1 #1–#7, #37–#42) over the read-replica-over-primary
 * session. Tile/metric/dashboard reads run under `withReportSession` (RLS-scoped, read-only, tiered
 * statement_timeout); the MV-admin commands enqueue the on-PRIMARY `report.mv_refresh` job through the
 * injected producer. `tiles` runs the translated SELECT for real (`buildDrizzleTileSqlExecutor`) — a
 * `registered`-status base still forward-seams to the empty tile (D6; that gate is inside `translateSpec`
 * itself, not this executor).
 */
export function buildDrizzleM33ReadService(deps: {
  db: DbClient;
  enqueue: M33ReadEnqueuePort;
}): { service: M33ReadRouteService } {
  return createDrizzleM33ReadBackend({
    replica: buildLiveReplicaSession(deps.db),
    lag: HEALTHY_SINGLE_POOL_LAG_GATE,
    enqueue: deps.enqueue,
    tiles: buildDrizzleTileSqlExecutor(),
  });
}

/**
 * Build the production WRITE route service (§4.1 #8–#31: definitions / views / shares / schedules) over the
 * org-pooled primary Drizzle client. EVERY method runs inside the tenant's own `withOrgContext` (RLS scopes
 * each statement to `app.org_id`) — fully live, cron math included (GAP-050, {@link LIVE_CRON}). The §4.10
 * `m33.*` outbox emit is bound when the composition root passes `outbox` (the catalog-validating tx
 * publisher); omitted in slice/tests, where it stays a best-effort no-op (zero regression).
 */
export function buildDrizzleM33WriteService(deps: {
  db: DbClient;
  outbox?: WriteOutboxPort;
}): {
  service: M33WriteRouteService;
} {
  return createDrizzleM33WriteBackend({
    db: deps.db,
    cron: LIVE_CRON,
    outbox: deps.outbox,
    now: () => new Date(),
  });
}

/**
 * Build the production EXPORT + DRILLDOWN route service (§4.1 #32–#36) over the read-replica-over-primary
 * session (the drilldown audit append writes under its own `withOrgContext` on the primary).
 *
 * BOUND for real: the export SQL executor (`tiles`, the SAME `buildDrizzleTileSqlExecutor` the read service
 * uses — CSV streams real rows now, not a header-only forward-seam); the M39 consent evaluator (`consent`,
 * lazily resolved via `getSeam("ConsentEvaluator")` at CALL time, RULE 4 — never captured eagerly at wiring
 * time, since M39 registers its real seam later in the same boot sequence); the §4.10 CSV/drilldown
 * telemetry outboxes (`csvOutbox`/`drilldownOutbox`) when `deps.outbox` is supplied — `drilldownOutbox`
 * remaps `DrilldownEmittedPayload`'s `drilldownTargetModule` field to the catalog's `targetModule` name (the
 * SAME field-name adaptation `apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts` makes for the
 * `report.drilldown_audit_flush` worker's identical emit).
 *
 * STILL fail-closed/forward-seam (genuine infra gaps, not this file's to invent): `exportOutbox` (PDF/XLSX →
 * 503 `ExportRenderUnbound` — `ExportRenderRequestPayload` does not satisfy the
 * `m33.scheduled_report.render_requested` catalog schema, the same package-level mismatch the jobs file
 * documents) and `drilldownEncryption` (→ `DrilldownDekUnavailable` deny — the M1 envelope-DEK/KMS provider
 * does not exist anywhere in this codebase yet).
 */
export function buildDrizzleM33ExportDrilldownService(deps: {
  db: DbClient;
  outbox?: {
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
  };
}): {
  service: M33ExportDrilldownRouteService;
} {
  const tiles = buildDrizzleTileSqlExecutor();
  const consent: Pick<ReportingConsentConsumer, "evaluateForReporting"> = {
    evaluateForReporting: (input) =>
      (getSeam("ConsentEvaluator") as ReportingConsentConsumer).evaluateForReporting(input),
  };
  const csvOutbox: CsvExportOutboxPort | undefined = deps.outbox
    ? {
        emitCsvStreamed: (payload) =>
          deps.outbox!.publish(deps.db, {
            eventName: "m33.export.csv_streamed",
            payload,
            organizationId: payload.organizationId,
            aggregateKind: "report_view",
            aggregateId: payload.viewId,
          }),
      }
    : undefined;
  const drilldownOutbox: DrilldownAuditOutboxPort | undefined = deps.outbox
    ? {
        emitDrilldown: (payload) =>
          deps.outbox!.publish(deps.db, {
            eventName: "m33.drilldown.emitted",
            payload: {
              drilldownTraceId: payload.drilldownTraceId,
              actorMembershipId: payload.actorMembershipId,
              sourceTileKey: payload.sourceTileKey,
              targetModule: payload.drilldownTargetModule,
              isConsentNarrowed: payload.isConsentNarrowed,
              organizationId: payload.organizationId,
              drilldownTargetSurface: payload.drilldownTargetSurface,
              consentNarrowingReason: payload.consentNarrowingReason,
              outcome: payload.outcome,
            },
            organizationId: payload.organizationId,
            aggregateKind: "report_drilldown_audit",
            aggregateId: payload.drilldownTraceId,
          }),
      }
    : undefined;
  return createDrizzleM33ExportDrilldownBackend({
    db: deps.db,
    replica: buildLiveReplicaSession(deps.db),
    lag: HEALTHY_SINGLE_POOL_LAG_GATE,
    tiles,
    consent,
    csvOutbox,
    drilldownOutbox,
  });
}
