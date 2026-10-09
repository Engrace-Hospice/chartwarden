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
import { DegradedError } from "@wardenx/types";
import type { ConnectionOptions } from "bullmq";
import { Queue } from "bullmq";
import { parseExpression } from "cron-parser";
import { sql } from "drizzle-orm";

import type { DbClient } from "@wardenx/db";
import {
  type CsvExportOutboxPort,
  DashboardCatalogProviderImpl,
  type DashboardMetricExecutorPort,
  type DrilldownAuditOutboxPort,
  type ExportRenderOutboxPort,
  MetricsProviderImpl,
  type ReadReplicaSessionPort,
  type ReplicaLagGatePort,
  ReportCatalogRepository,
  type ReportingConsentConsumer,
  type ReportingDb,
  type TranslatorBaseCatalog,
  translateSpec,
  withReportSession,
} from "@wardenx/reporting";
import { isValidTimeZone } from "@wardenx/shared/dates";
import { registerPlatformJob, withOrgContext } from "@wardenx/tenancy";

import { getSeam, registerSeam } from "../../bootstrap/index";
import { resolveReportableScope } from "./abac-predicates";
import { buildDrizzleReportingAbacResolver } from "./abac-resolver-db";
import {
  type DrilldownTenantKeyProvider,
  createDrilldownFilterEncryption,
} from "./drilldown-crypto";
import {
  CronExpressionInvalidError,
  type CronPort,
  type M33ExportDrilldownRouteService,
  type M33ReadEnqueuePort,
  type M33ReadRouteService,
  type M33WriteRouteService,
  type ReportScopeResolverPort,
  type WriteOutboxPort,
  createDrizzleM33ExportDrilldownBackend,
  createDrizzleM33ReadBackend,
  createDrizzleM33WriteBackend,
} from "./routes/index";
import { buildDrizzleTileSqlExecutor } from "./sql-executor";

/**
 * The registered platform-job id M33's platform-scoped §4.8 workers (the on-PRIMARY MV refresh, the lag
 * probe, the tenant-offboarding eraser) enter `withPlatformContext` under. Registered on the
 * `@wardenx/tenancy` allowlist by {@link wireM33Tenancy} at boot — until then `withPlatformContext` REFUSES
 * the caller (fail-closed; the allowlist starts empty). The M34 `M34_PLATFORM_JOB_ID` precedent.
 */
export const M33_PLATFORM_JOB_ID = "m33.platform_ops";

/**
 * Raised by a still-unbound infra port (the fail-closed signal — never a silent no-op).
 *
 * A `DegradedError`, so the caller gets `503 DEGRADED` naming the missing dependency rather than the
 * `500 INTERNAL_ERROR / "An unexpected error occurred"` a bare `Error` collapsed into (F-022 / #55).
 * A deliberately unbound port IS the dependency-unavailable condition `DegradedError` exists for,
 * and the M34 `M34InfraPortUnbound` precedent already took that posture. `reason` is the whole of
 * the caller-facing message — the internal port name stays on `port`, where the log can read it and
 * the response cannot.
 *
 * `component` defaults to the background queue because every current throw site is a queue producer;
 * a future non-queue port passes its own rather than mislabelling itself.
 */
export class M33InfraPortUnbound extends DegradedError {
  constructor(
    public readonly port: string,
    reason: string,
    component = "background-queue",
  ) {
    super(component, reason);
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
 * Evaluate ONE catalogued metric over the MV substrate — the {@link DashboardMetricExecutorPort} behind
 * `MetricsProviderImpl` (§4.3).
 *
 * F-044: this port had no implementation anywhere, so `MetricsProviderImpl` was constructed WITHOUT it and
 * took its own `!this.deps.executor` branch on every call. The seam was registered, the endpoint was
 * mounted, the catalog lookup ran — and the answer was `value: null, isForwardSeamDenyStub: true` for every
 * metric, for every consumer (M30's HQRP measure-detail embed, M34's ops console, M37's IPU tiles), forever.
 * A metric that is genuinely not materialized yet and one whose executor was never built are the same
 * response, which is why nothing surfaced it.
 *
 * A metric belongs to whichever ACTIVE base declares a measure bound to it (`MeasureCatalog.metricKey`), so
 * resolution is: find that base → build a one-measure KPI spec → translate → execute → read the scalar.
 * No new SQL surface and no new catalog concept: this is `readTile` narrowed to a single measure, through
 * the same translator and the same executor.
 *
 * Scope is `org` here, and deliberately: the seam's callers are OTHER MODULES' server-side embeds, which
 * hold no M33 route actor to resolve a §4.7.1 envelope for. The consuming module gates its own surface,
 * and every value crossing this seam is an org aggregate (D6). A metric on a member-grain base is still
 * org-summed — the seam has no way to say "this clinician" and does not pretend to.
 */
function buildDashboardMetricExecutor(
  db: DbClient,
  tiles: ReturnType<typeof buildDrizzleTileSqlExecutor>,
): DashboardMetricExecutorPort {
  const replica = buildLiveReplicaSession(db);
  const empty = { value: null, rowCount: 0, isForwardSeamDenyStub: true } as const;
  return {
    async evaluate(input) {
      return withReportSession(
        { orgId: input.organizationId, tier: "tile" },
        { replica },
        async (sessionDb) => {
          const catalog = new ReportCatalogRepository(sessionDb);
          const bases = await catalog.listBases("active");
          let base: (typeof bases)[number] | undefined;
          let measureKey: string | undefined;
          for (const candidate of bases) {
            const measure = candidate.measures.find((m) => m.metricKey === input.metricKey);
            if (measure) {
              base = candidate;
              measureKey = measure.measureKey;
              break;
            }
          }
          if (!base || !measureKey) return empty;
          const mv = await catalog.findMvByKey(base.mvKey);
          if (!mv) return empty;
          const translatorBase: TranslatorBaseCatalog = {
            baseKey: base.baseKey,
            status: base.status,
            mvKey: base.mvKey,
            mvSchemaName: mv.schemaName,
            mvStatus: mv.status,
            dimensions: base.dimensions,
            measures: base.measures,
            maxRowLimit: base.maxRowLimit,
            drilldownUrlTemplate: base.drilldownUrlTemplate,
            scopeMembershipColumn: base.scopeMembershipColumn,
            scopeLocationColumn: base.scopeLocationColumn,
          };
          const translation = translateSpec(
            { dimensions: [], measures: [{ measureKey }], filters: [] },
            translatorBase,
            { scopeKind: "org", organizationId: input.organizationId },
          );
          if (translation.kind === "deny_stub") return empty;
          const { rows, rowCount } = await tiles.execute(sessionDb, {
            sql: translation.sql,
            params: translation.params,
          });
          const first = rows[0] as Record<string, unknown> | undefined;
          const raw = first?.[measureKey];
          const value = raw === null || raw === undefined ? null : Number(raw);
          return {
            value: value !== null && Number.isFinite(value) ? value : null,
            rowCount,
            isForwardSeamDenyStub: false,
          };
        },
      );
    },
  };
}

/**
 * The three PUBLISHED §4.3 seam implementations over one live replica session + one metric executor.
 * Shared by `registerReportingMetricsSeam` and `buildDrizzleM33ReadService` so the in-process seam and the
 * HTTP face of that same seam (#42) cannot answer differently — they were two independent deny paths for
 * one fact before F-044.
 */
function buildReportingPublishedSeams(db: DbClient) {
  const replica = buildLiveReplicaSession(db);
  const executor = buildDashboardMetricExecutor(db, buildDrizzleTileSqlExecutor());
  return {
    metrics: new MetricsProviderImpl({ replica, lag: HEALTHY_SINGLE_POOL_LAG_GATE, executor }),
    dashboards: new DashboardCatalogProviderImpl({
      replica,
      lag: HEALTHY_SINGLE_POOL_LAG_GATE,
    }),
  };
}

/**
 * Register M33's PUBLISHED `MetricsProvider` seam (#107 item 2 / §4.3) into the M1 SeamRegistry — the embedded
 * dashboard-metric read M30/M34/M37 resolve via `getSeam`. The read runs under the replica-over-primary
 * session (RLS-scoped to the caller's org) and now carries a REAL MV executor (F-044), so a `value: null,
 * isForwardSeamDenyStub: true` answer once again means what it says: the metric's MV has not materialized.
 * When no db is present the M1 fail-closed deny-stub stands. Called by the composition root in
 * `wireModuleSeams` (the M10 `registerHopeSeams` precedent).
 */
export function registerReportingMetricsSeam(db: DbClient | undefined): void {
  if (!db) return;
  registerSeam("MetricsProvider", buildReportingPublishedSeams(db).metrics);
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
  const published = buildReportingPublishedSeams(deps.db);
  return createDrizzleM33ReadBackend({
    replica: buildLiveReplicaSession(deps.db),
    lag: HEALTHY_SINGLE_POOL_LAG_GATE,
    enqueue: deps.enqueue,
    tiles: buildDrizzleTileSqlExecutor(),
    dashboards: published.dashboards,
    metrics: published.metrics,
    scope: buildReportScopeResolver(deps.db),
  });
}

/**
 * The §4.7.1 D8 scope resolver every M33 read narrows on — `resolveReportableScope` over the PRODUCTION
 * Drizzle `ReportingAbacResolver`, i.e. the same resolution the `reportable_scope` predicate performs.
 *
 * F-059: that resolution has run on every request since M33 landed, inside the predicate, which then
 * threw the envelope away and returned a boolean. Every read path built its OWN envelope, hard-defaulting
 * to `org`, so the authorization gate and the query narrowing disagreed about what the actor may see and
 * only the gate's answer was ever wrong-side-safe. One resolver now feeds both.
 */
export function buildReportScopeResolver(db: DbClient): ReportScopeResolverPort {
  const resolver = buildDrizzleReportingAbacResolver(db);
  return {
    async resolve(actor) {
      const envelope = await resolveReportableScope(
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          roles: [...actor.roles],
          attributes: actor.membershipId ? { membershipId: actor.membershipId } : {},
        } as never,
        {} as never,
        resolver,
      );
      // The predicate's envelope names the field `kind` and stamps `sealed: true` "so the SQL
      // scope-injector accepts it"; the injector's envelope names it `scopeKind` and has no `sealed`
      // field to check. The two shapes have never been assignable — a third way this chain could not have
      // been connected without someone noticing, alongside the discarded resolution and the MV columns
      // that do not exist. Translated here, at the one seam between the ABAC vocabulary and the SQL one.
      return {
        scopeKind: envelope.kind,
        organizationId: envelope.organizationId,
        membershipIds: envelope.membershipIds,
        locationIds: envelope.locationIds,
      };
    },
  };
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
 * `exportOutbox` is BOUND too as of GAP-051 (PDF/XLSX used to 503 `ExportRenderUnbound`), over the same
 * `deps.outbox` publisher: the render request goes out as `m33.scheduled_report.render_requested` with the
 * aggregate the reply keys back by (`report_export` / the exportId). The payload carries the executed rows,
 * so this is a real handshake, not a request M22 could never answer.
 *
 * `drilldownEncryption` is BOUND over `deps.tenantKeys` (GAP-056; the M34 per-tenant DEK provider the other
 * modules seal under). Fail-closed still holds when no provider is passed: the emit denies with
 * `DrilldownDekUnavailable` rather than storing the filter context in the clear.
 */
export function buildDrizzleM33ExportDrilldownService(deps: {
  db: DbClient;
  /** GAP-056 - per-tenant DEK provider the drilldown filter envelope seals under (absent => fail-closed deny). */
  tenantKeys?: DrilldownTenantKeyProvider;
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
  const scope = buildReportScopeResolver(deps.db);
  const consent: Pick<ReportingConsentConsumer, "evaluateForReporting"> = {
    evaluateForReporting: (input) =>
      (getSeam("ConsentEvaluator") as ReportingConsentConsumer).evaluateForReporting(input),
  };

  /**
   * Publish one §4.10 event through the tx-scoped publisher, INSIDE the tenant's own `withOrgContext`.
   *
   * All three of these emits used to hand the publisher `deps.db` — the bare pool — with no org context
   * around it, and the row's own `organizationId` was expected to carry the day. It does not:
   * `outbox_event`'s RLS policy is `organization_id = current_setting('app.org_id', true)::uuid`, and on a
   * POOLED connection that has already served one `withOrgContext`/`withReportSession` transaction, a
   * custom GUC set with `set_config(…, true)` does not revert to unset — it reverts to the EMPTY STRING.
   * `''::uuid` then raises `invalid input syntax for type uuid: ""` (22P02), so the publish blew up with a
   * cast error rather than either succeeding or failing cleanly as an RLS denial — and only on a reused
   * connection, which is every connection in a warm process and no connection in a fresh unit test.
   */
  const publishInOrgTx = (input: {
    readonly eventName: string;
    readonly payload: Record<string, unknown>;
    readonly organizationId: string;
    readonly aggregateKind: string;
    readonly aggregateId: string;
  }): Promise<void> =>
    withOrgContext<DbClient, void>(
      deps.db,
      { organizationId: input.organizationId, userId: "" },
      (tx) => deps.outbox!.publish(tx, input),
    );
  const csvOutbox: CsvExportOutboxPort | undefined = deps.outbox
    ? {
        emitCsvStreamed: (payload) =>
          publishInOrgTx({
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
          publishInOrgTx({
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
  // GAP-051 — the §1.1 render handshake for the ad-hoc "export now" routes (#33/#34). The aggregate is the
  // EXPORT (`report_export` / exportId), which is what M22's reply keys back by; `idempotencyKey =
  // exportId` gives at-most-once render across a redelivered request. Unbound (no publisher), the service
  // keeps raising `ExportRenderUnbound` rather than dropping the request.
  const exportOutbox: ExportRenderOutboxPort | undefined = deps.outbox
    ? {
        emitRenderRequested: (payload) =>
          publishInOrgTx({
            eventName: "m33.scheduled_report.render_requested",
            payload: { ...payload },
            organizationId: payload.organizationId,
            aggregateKind: payload.aggregateType,
            aggregateId: payload.aggregateId,
          }),
      }
    : undefined;
  return createDrizzleM33ExportDrilldownBackend({
    db: deps.db,
    replica: buildLiveReplicaSession(deps.db),
    lag: HEALTHY_SINGLE_POOL_LAG_GATE,
    tiles,
    scope,
    consent,
    csvOutbox,
    drilldownOutbox,
    exportOutbox,
    drilldownEncryption: deps.tenantKeys
      ? createDrilldownFilterEncryption(deps.tenantKeys)
      : undefined,
  });
}
