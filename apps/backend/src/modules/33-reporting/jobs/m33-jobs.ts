// apps/backend/src/modules/33-reporting/jobs/m33-jobs.ts — M33 Phase 2C LIVE BullMQ wiring for the §4.8 jobs.
// The thin, infra-touching adapter that turns the @wardenx/reporting pure workers (catalog in ./index.ts)
// into running BullMQ `Worker`s + the cron-schedule `Queue`s. All job LOGIC lives in the package (unit-tested
// against in-memory ports); this module only constructs `Worker`/`Queue` over a Valkey connection and BINDS
// each worker's PORTS to real adapters — the M33 repos (catalog / run-ledger / tile-cache / drilldown-audit /
// schedule), the PRIMARY-pool `REFRESH MATERIALIZED VIEW CONCURRENTLY` + `pg_stat_replication` lag sample via
// `db.execute`, and the still-missing cross-module reach (M22 render outbox, M36 alert router, M39 consent
// re-validation, M1 envelope-DEK / replica-session / Valkey state) as LAZY fail-closed thunks. Mirrors
// apps/backend/src/modules/34-saas-tenant-platform/jobs/saas-jobs.ts EXACTLY (the worker-construction template:
// `new Worker(queue, processor, { connection })` + `new Queue(...)`; injected connection; the caller owns
// lifecycle/close). Nothing here is invoked at import — constructing a Worker is what opens the Valkey
// connection, and that happens only inside these functions (never in tests / at module load).
//
// IMPORTANT (per the Phase-2C split): this file BUILDS the adapters + the workers; it does NOT mount them into
// the app. The Integration agent calls `registerM33Workers` / `scheduleM33Jobs` from the composition root once
// the Valkey connection + the missing M1 infra seams (the read-replica session, the envelope-DEK helper, the
// live outbox dispatcher, the programmatic M36 alert router, the Valkey lag-probe state) are available. Until
// then the bindable ports are bound and the genuinely-missing ones carry a typed TODO + a fail-closed throw
// (never a silent no-op).
//
// THE M34 EAGER-BIND GOTCHA (followed exactly): a missing port is bound to a LAZY `() => unbound(...)` thunk so
// the throw happens only when a JOB RUNS — never at port-bundle construction. The host MUST boot with the
// BullMQ connection enabled even when an adapter is absent; an eager `unbound(...)` call would crash boot.
//
// SAFETY INVARIANTS (§2.4 / §3.6 / D3 / D14):
//   • the MV-refresh worker REFRESHes on the PRIMARY pool (D3 — the one M33 path that writes); it never reads
//     the replica. `report_mv.*` views are platform-global (org=null), so the refresh runs platform-scoped.
//   • the drilldown-audit writer ENVELOPE-ENCRYPTS the filter context FIRST — the encryption port is unbound
//     here, so a run fails closed (DrilldownDekUnavailable) and writes NOTHING (never plaintext at rest, §3.6).
import { randomUUID } from "node:crypto";
import { type AuditContext, audit } from "@wardenx/audit";
import { type DbClient, schema } from "@wardenx/db";
import {
  type CsvExportPorts,
  DashboardTileCacheRepository,
  type DrilldownAuditInput,
  type DrilldownAuditPorts,
  type ExportRenderRequestPayload,
  type LagProbePorts,
  type MvRefreshEnqueueOutcome,
  type MvRefreshJob,
  type MvRefreshQueuePort,
  type MvRefreshWorkerPorts,
  type NightlyRefreshPorts,
  type PdfRenderRequestPorts,
  ReportCatalogRepository,
  ReportDefinitionRepository,
  ReportDrilldownAuditRepository,
  ReportRunRepository,
  ReportScheduleRepository,
  ReportViewRepository,
  type ReportableScopeEnvelope,
  type ReportingConsentConsumer,
  type ScheduledRunJob,
  type ScheduledRunPorts,
  type TranslatorBaseCatalog,
  type XlsxRenderRequestPorts,
  runNightlyRefresh,
  translateSpec,
} from "@wardenx/reporting";
import { type PlatformBypassAuditor, withOrgContext, withPlatformContext } from "@wardenx/tenancy";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { eq, sql } from "drizzle-orm";
import type Redis from "ioredis";
import { getSeam } from "../../../bootstrap/index";
import { buildDrizzleTileSqlExecutor } from "../sql-executor";
import { M33_PLATFORM_JOB_ID } from "../wiring";
import {
  type ExportRenderJob,
  type ExportRenderProcessorPorts,
  type LagProbeJob,
  M33_JOB_SCHEDULES,
  M33_QUEUES,
  M33_QUEUE_PARAMS,
  drilldownAuditFlushProcessor,
  exportRenderProcessor,
  lagProbeProcessor,
  mvRefreshProcessor,
  scheduledRunProcessor,
} from "./index";
import { createRedisLagProbeAdvisoryPort, createRedisLagProbeStatePort } from "./lag-probe-state";

// ── the dep bag the composition root injects (the bindable infra + the still-missing seams) ────────────

/**
 * The dependencies the live M33 worker wiring binds the §2 worker ports over. The Integration agent supplies
 * these at the composition root. Each maps onto the SAME interfaces the package workers already take — this
 * file's job is to BIND them (it never rewrites a worker).
 *
 * The shapes typed here are the ones available in the repo today (the Drizzle client, the Valkey connection).
 * The cross-module infra a worker also needs (the M1 read-replica session + envelope-DEK helpers, the live
 * outbox dispatcher, the programmatic M36 alert router, the M39 reporting-consent evaluator) does NOT have a
 * stable accessor yet — those are absent here and the corresponding port throws a typed `M33WorkerPortUnbound`
 * rather than silently no-op'ing.
 */
export interface M33WorkerDeps {
  /** The Valkey/Redis connection the `Worker`/`Queue` open over (injected, same as M34 saas-jobs). */
  readonly connection: ConnectionOptions;
  /** The org-scoped Drizzle client the repos run under (wrapped per-job in withOrgContext/withReportSession). */
  readonly db: DbClient;
  /**
   * The PRIMARY-pool Drizzle client for the MV-refresh worker (D3 — REFRESH writes on the primary) + the
   * `pg_stat_replication` lag sample. TODO(integrator): pass M1's primary pool; until it is available the
   * refresh/probe use `db` (fine in a single-pool dev boot, but NOT the dedicated primary the spec mandates).
   */
  readonly primaryDb?: DbClient;
  /**
   * The separately-pooled platform login role `withPlatformContext` opens its tx on (NOT the tenant pool —
   * `mvRefresh`/`lagProbe` are platform-scoped, {@link M33_QUEUE_SCOPE}). Defaults to `db` when absent,
   * matching the M30/M27/M25/M7/M9/M10 `buildActiveOrgEnumerator` call sites in the composition root today
   * (a genuinely separate platform pool is architecturally intended but not yet provisioned — every other
   * platform-scoped cron in this codebase reuses the tenant pool the same way).
   */
  readonly platformDb?: DbClient;
  /**
   * Audits every `withPlatformContext` entry (fail-closed: absent ⇒ a platform-scoped job throws when it
   * runs, never silently skips the audit). The composition root passes the SAME shared
   * `m34PlatformBypassAuditor` (apps/backend/src/index.ts) every other platform-scoped module uses — despite
   * the name, it is module-agnostic (its event records the caller's own jobId).
   */
  readonly auditBypass?: PlatformBypassAuditor<DbClient>;
  /** Injected clock (deterministic in tests; the package workers stamp every instant through this). */
  now?: () => Date;
  /**
   * The SAME tx-scoped `m33` outbox publisher the write-service command routes already use
   * (`bindCallerModule(txOutboxPublisher, "m33")`). Bound over this, every §4.10 `m33.*` job emit lights up
   * (M22 render handshake, M36 alerts, M1 system_status, the self-subscriber cache-invalidate/audit-flush
   * events) — all of them are plain outbox publishes once a tx-scoped publisher exists; there is no separate
   * per-event infra to build. `drilldownAuditFlush.encryption.encryptFilters` is the one M33 port this does
   * NOT unblock (it needs the M1 envelope-DEK helper, which still does not exist — see the module TODO).
   */
  readonly outboxPublisher?: {
    publish(
      tx: DbClient,
      input: {
        readonly eventName: string;
        readonly payload: Record<string, unknown>;
        readonly organizationId: string | null;
        readonly aggregateKind: string;
        readonly aggregateId: string;
      },
    ): Promise<void>;
  };
  /**
   * A dedicated Valkey/Redis client for the `report.lag_probe` singleton's mutable state (hysteresis +
   * degraded-tile advisory, §2.4/D14) — see `./lag-probe-state.ts`. Separate from `connection` (BullMQ's
   * broad `ConnectionOptions` union isn't necessarily a live ioredis instance) so the probe's two Redis keys
   * work over a plain, already-connected `ioredis` client the composition root constructs once.
   */
  readonly lagProbeRedis?: Redis;
  /**
   * The `report.mv_refresh` producer the nightly orchestrator (`runNightlyRefresh`) fans per-MV refresh jobs
   * out onto — a SEPARATE BullMQ `Queue` handle from the `connection` a `Worker` opens (a producer needs its
   * own `Queue.add`). Built by `buildM33MvRefreshEnqueue` below; the composition root constructs one instance
   * and passes it here (mirrors the M27/M30 recompute-enqueue precedent, including the same BullMQ
   * "jobId cannot contain ':'" sanitization the dispatcher's `mv_refresh:<mvKey>:<floorMs>` jobId needs).
   */
  readonly mvRefreshEnqueue?: MvRefreshQueuePort;
  /** The CURRENT job's organizationId (set on each per-job port rebuild in `registerM33Workers`) — threaded
   *  through to `systemAuditContext()` since `RunnerAuditPort`'s methods don't carry an orgId parameter of
   *  their own. `null` outside a per-job rebuild (platform-scoped jobs; the audit context omits org scope). */
  readonly jobOrganizationId?: string | null;
}

/** Raised when a worker port could not be bound to a real adapter (the missing-infra fail-closed signal).
 *  Surfacing it (vs a silent no-op) keeps a half-wired worker from running an effect blind. The M34
 *  `M34WorkerPortUnbound` precedent (the package's own `M33RefreshPortUnbound` covers the refresh ports). */
export class M33WorkerPortUnbound extends Error {
  constructor(port: string, reason: string) {
    super(`M33 worker port '${port}' is not bound to a real adapter: ${reason}`);
    this.name = "M33WorkerPortUnbound";
  }
}

const unbound = (port: string, reason: string): never => {
  throw new M33WorkerPortUnbound(port, reason);
};

/** The audit() actor context for a background job — no acting user, so `userId: null` / `actorKind:
 *  "system"` (mirrors the M30 §4.8 system-sentinel precedent). A fresh `correlationId` per call: a job's
 *  audit rows are not part of an HTTP request's correlation chain. */
function systemAuditContext(organizationId: string | null = null): AuditContext {
  return { organizationId, userId: null, actorKind: "system", correlationId: randomUUID() };
}

/** `outbox_event.aggregate_id` is a real `uuid` NOT NULL column; the replica-lag probe is a genuine
 *  platform singleton with no natural entity id, so its outbox emits use this fixed, stable uuid rather
 *  than inventing a fake per-run identity. */
const LAG_PROBE_SINGLETON_AGGREGATE_ID = "00000000-0000-4000-8000-000000000001";

/** Resolves `materialized_view_metadata.mv_key`'s real `uuid` PK for `outbox_event.aggregate_id`
 *  (a real uuid column — `mvKey` is a text business key, never a valid uuid itself). */
async function mvAggregateId(catalogRepo: ReportCatalogRepository, mvKey: string): Promise<string> {
  const mv = await catalogRepo.findMvByKey(mvKey);
  if (!mv)
    throw new Error(`materialized_view_metadata '${mvKey}' not found for outbox aggregateId`);
  return mv.id;
}

// ── the per-queue port bundles (bind what we can; throw-on-call for the genuinely-missing infra) ────────

/** The bound port bundles `registerM33Workers` drives the §4.8 workers with. */
export interface M33WorkerPortBundles {
  readonly mvRefresh: MvRefreshWorkerPorts;
  readonly scheduledRun: ScheduledRunPorts;
  readonly exportRender: ExportRenderProcessorPorts;
  readonly lagProbe: LagProbePorts;
  readonly drilldownAuditFlush: DrilldownAuditPorts;
  /** The direct CSV streamer ports (route-driven; no BullMQ worker — see `csvExportProcessor`). */
  readonly csvExport: CsvExportPorts;
}

/**
 * Build every §2 worker's port bundle from {@link M33WorkerDeps}. Pure assembly — no `Worker`/`Queue` here, so
 * the binding is unit-inspectable. The BINDABLE ports (the M33 repos + the PRIMARY-pool REFRESH / lag-sample
 * reached through `db.execute(sql\`…\`)`) are wired to real adapters; the still-missing cross-module infra
 * ports carry a LAZY typed `M33WorkerPortUnbound` throw + a TODO naming the integrator's seam.
 *
 * NB: the per-job tenancy envelope (withReportSession / withOrgContext for org-scoped jobs;
 * withPlatformContext for the platform jobs, {@link M33_QUEUE_SCOPE}) is applied by the WORKER closure / the
 * integrator — the repos issue plain Drizzle inside whichever transaction the envelope opens. Here we hand the
 * repos the base client; the envelope is the worker's job (mechanism-vs-policy: the worker owns the RLS
 * envelope, F09 — the M34 precedent).
 */
export function buildM33WorkerPorts(deps: M33WorkerDeps): M33WorkerPortBundles {
  const now = deps.now ?? (() => new Date());
  const db = deps.db;
  const primaryDb = deps.primaryDb ?? deps.db;

  // GAP-051 — the SAME `translateSpec`-result executor the read/export route services use, so the
  // scheduled runner materializes its snapshot through one code path, not a second copy.
  const snapshotExecutor = buildDrizzleTileSqlExecutor();

  const catalogRepo = new ReportCatalogRepository(primaryDb); // materialized_view_metadata registry (§3.3)
  const runRepo = new ReportRunRepository(primaryDb); // report_run + report_schedule_run ledgers
  const scheduleRepo = new ReportScheduleRepository(db); // report_schedule (org-scoped reads)
  const tileRepo = new DashboardTileCacheRepository(db); // dashboard_tile_cache (deleteByOrg invalidation)
  const drilldownRepo = new ReportDrilldownAuditRepository(db); // report_drilldown_audit (insert-only append)

  // ── report.mv_refresh (PRIMARY pool — D3; platform-global org=null) ──────────────────────────────────
  // BOUND: the metadata read/telemetry, the run ledger, the REFRESH executor, the org-scoped tile-cache
  // invalidation. UNBOUND (lazy): the three §4.9 outbox emits (need the live transactional-outbox dispatcher).
  const mvRefresh: MvRefreshWorkerPorts = {
    now,
    metadataRead: {
      findByKey: (mvKey) => catalogRepo.findMvByKey(mvKey),
    },
    metadataWrite: {
      async stamp(mvKey, patch) {
        await catalogRepo.updateMvRefreshTelemetry(mvKey, patch);
      },
    },
    runs: {
      async open(input) {
        const row = await runRepo.createMvRun({
          id: randomUUID(),
          mvKey: input.mvKey,
          organizationId: input.organizationId,
          triggerKind: input.triggerKind,
          triggerOutboxEventId: input.triggerOutboxEventId,
          startedAt: input.startedAt,
          status: "running",
          retryAttempt: input.retryAttempt,
        });
        return { id: row.id, startedAt: row.startedAt };
      },
      async settle(handle, patch) {
        await runRepo.updateMvRunStatus(handle.id, handle.startedAt, {
          status: patch.status,
          finishedAt: patch.finishedAt,
          durationMs: patch.durationMs,
          rowsAffected: patch.rowsAffected,
          failureReason: patch.failureReason,
        });
      },
    },
    exec: {
      // D3 — the one M33 write path: REFRESH on the PRIMARY (CONCURRENTLY keeps the MV readable). The schema +
      // mv key are quoted identifiers (never string-interpolated) so a registry key can never inject SQL.
      async refreshConcurrently({ schemaName, mvKey }) {
        await primaryDb.execute(
          sql`REFRESH MATERIALIZED VIEW CONCURRENTLY ${sql.identifier(schemaName)}.${sql.identifier(mvKey)}`,
        );
        return { rowsAffected: null }; // REFRESH reports no row count
      },
    },
    tileCache: {
      // BOUND for the org-scoped case (DashboardTileCacheRepository.deleteByOrg). The platform-global refresh
      // (org=null) is a documented NO-OP, not a throw: `dashboard_tile_cache` has no producer wiring anywhere
      // in the backend today (`report.tile_warm_cache` carries no BullMQ consumer or enqueue call — WX-PR-014
      // leaves it dormant, see the module TODO; `readTile` computes tiles live off `deps.tiles`, it never
      // upserts into the cache) — the table is unconditionally empty in production, so a platform-wide refresh
      // has nothing to invalidate. Throwing here would be the SAME bug class WX-PR-014 fixed in M30's
      // `risk_register_refresh`: an unconditional throw on the SUCCESS path of `handleMvRefresh` (this call
      // sits inside its `try`, after the run is already settled "succeeded") turns every successful
      // platform-wide refresh into a recorded FAILURE and, after enough consecutive "failures", suspends the
      // MV — over a cache table that was never going to have a row to delete either way.
      async invalidateForMv({ organizationId }) {
        if (organizationId === null) return 0;
        return tileRepo.deleteByOrg(organizationId);
      },
    },
    // BOUND for real over `deps.outboxPublisher` with `organizationId: null` — the platform-wide-event
    // persist path (migration 0186's `report_writer_insert_platform_outbox_event` SECURITY DEFINER
    // function, invoked transparently inside `buildTxOutboxPublisher`'s persist step when
    // `organizationId === null`) makes this a real, durable write now, not a permanent block. `report_mv.*`
    // views are platform-global (§2.4 — every `report.mv_refresh` job runs under `withPlatformContext`),
    // so `organizationId: null` on every one of these three emits is correct, not a placeholder.
    //
    // Called UNCONDITIONALLY on the success/failure paths inside `handleMvRefresh` (refresh-worker.ts) —
    // this pass's OWN first draft left these as fail-closed throws instead, and a live test immediately
    // caught the exact `unbound()`-on-an-unconditional-call bug class WX-PR-014 fixed in M30
    // (`measure_recompute.outbox.emitValueEmitted`): a throw here turns a successful REFRESH into a run
    // recorded as FAILED. Binding for real (rather than leaving the no-op fallback) closes that
    // permanently — a publish failure now surfaces as the real error it is, not a synthetic one.
    outbox: {
      // `outbox_event.aggregate_id` is a real `uuid` column — `mvKey` is a text business key
      // (`materialized_view_metadata.mv_key`), not the row's own `uuid` PK, so each emit resolves the
      // real PK first (one extra lookup, on the already-open `catalogRepo`/`primaryDb`).
      emitRefreshSucceeded: async (payload) => {
        const aggregateId = await mvAggregateId(catalogRepo, payload.mvKey);
        await deps.outboxPublisher!.publish(db, {
          eventName: "m33.mv.refresh_succeeded",
          payload: { ...payload },
          organizationId: null,
          aggregateKind: "materialized_view_metadata",
          aggregateId,
        });
      },
      emitRefreshFailed: async (payload) => {
        const aggregateId = await mvAggregateId(catalogRepo, payload.mvKey);
        await deps.outboxPublisher!.publish(db, {
          eventName: "m33.mv.refresh_failed",
          payload: { ...payload },
          organizationId: null,
          aggregateKind: "materialized_view_metadata",
          aggregateId,
        });
      },
      emitRefreshExhausted: async (payload) => {
        const aggregateId = await mvAggregateId(catalogRepo, payload.mvKey);
        await deps.outboxPublisher!.publish(db, {
          eventName: "m33.mv.refresh_exhausted",
          payload: { ...payload },
          organizationId: null,
          aggregateKind: "materialized_view_metadata",
          aggregateId,
        });
      },
    },
  };

  // ── report.scheduled_run (withOrgContext — the requesting tenant, F09) ────────────────────────────────
  // BOUND: the schedule read + the run-ledger read/settle. UNBOUND (lazy): the M39 recipient re-validation,
  // the translator snapshot build, the M22/M36 outbox emits, the schedule auto-pause, and the §164.528 audit.
  const scheduledRun: ScheduledRunPorts = {
    now,
    schedules: {
      findById: (scheduleId) => scheduleRepo.findById(scheduleId),
    },
    runs: {
      findRun: (runId, scheduledFor) => runRepo.findScheduleRunById(runId, scheduledFor),
      async settle(runId, scheduledFor, patch) {
        await runRepo.updateScheduleRunStatus(runId, scheduledFor, patch);
      },
    },
    // BOUND: an M2 active-membership re-validation (the recipient's membership must still be ACTIVE in the
    // SAME org the schedule was created under). This is narrower than the doc-comment's original aspiration
    // ("M39 ConsentEvaluator.evaluateForReporting") — that method takes a PATIENT-identifier cohort for
    // drilldown PHI narrowing (packages/reporting/src/seams/consumed/m39-consent.ts); a scheduled report's
    // recipient list carries membership ids, not patient ids, so that method is the wrong shape for THIS
    // re-validation and is not called here. What IS re-validated is exactly the scenario W-R-04 names — "a
    // recipient may have lost access between schedule creation and this run" — for the membership-active
    // fact; it does not re-run the full `reportable_scope` ABAC permission check (that needs a live
    // request-context evaluator with no established background-job binding pattern in this codebase).
    recipients: {
      async isRecipientEntitled(membershipId, organizationId) {
        const [row] = await db
          .select({
            status: schema.memberships.status,
            organizationId: schema.memberships.organizationId,
          })
          .from(schema.memberships)
          .where(eq(schema.memberships.id, membershipId))
          .limit(1);
        return (
          row !== undefined && row.status === "active" && row.organizationId === organizationId
        );
      },
    },
    // BOUND: reuses the SAME view→version→definition→base→translateSpec chain
    // `export-drilldown-service.ts`'s `translateView` already runs in production for CSV/PDF/XLSX exports —
    // no new translation logic invented here. A `deny_stub` translation (the MV isn't materialized yet)
    // throws rather than emitting a fabricated snapshot query (D6 — never fail open).
    //
    // THE FLAGGED GAP IS CLOSED (GAP-051), the other way round. `SnapshotQueryPort.build` used to return
    // `snapshotQuery: string` alone and the wire event mirrored it, while `translateSpec` deliberately
    // keeps SQL text and bound params SEPARATE (D4) — so the text shipped to M22 carried literal `$1, $2,
    // …` markers with no params channel anywhere in the contract. The resolution is NOT to add a `params`
    // field: M22 has no reporting database to run the query against, and executing SQL text handed over an
    // event is the exact raw-SQL surface D4 exists to prevent. The port that owns the query, the tx and
    // the RLS scope EXECUTES it here and ships the ROWS — the same content-in-the-event shape every other
    // §7.2 requester uses. `snapshotQuery` stays on the wire as provenance (what was rendered).
    snapshot: {
      async build({ reportViewId, organizationId }) {
        const view = await new ReportViewRepository(db).findById(reportViewId);
        if (!view || view.organizationId !== organizationId) {
          throw new Error(`report_view ${reportViewId} not found for org ${organizationId}`);
        }
        const defRepo = new ReportDefinitionRepository(db);
        const version = await defRepo.findVersionById(view.definitionVersionId);
        if (!version) {
          throw new Error(`report_definition_version ${view.definitionVersionId} not found`);
        }
        const definition = await defRepo.findDefinitionById(version.definitionId);
        if (!definition) throw new Error(`report_definition ${version.definitionId} not found`);
        const base = await catalogRepo.findBaseByKey(definition.baseKey);
        if (!base) throw new Error(`report_base_catalog ${definition.baseKey} not found`);
        const mv = await catalogRepo.findMvByKey(base.mvKey);
        const spec = version.spec as schema.ReportDefinitionSpec;
        const filters = [...(spec.filters ?? []), ...(view.pinnedFilters ?? [])];
        const translatorBase: TranslatorBaseCatalog = {
          baseKey: base.baseKey,
          status: base.status,
          mvKey: base.mvKey,
          mvSchemaName: mv?.schemaName ?? base.mvKey,
          mvStatus: mv?.status ?? "registered",
          dimensions: base.dimensions,
          measures: base.measures,
          maxRowLimit: base.maxRowLimit,
          drilldownUrlTemplate: base.drilldownUrlTemplate,
        };
        const scope: ReportableScopeEnvelope = {
          scopeKind: "org",
          organizationId,
          membershipIds: [],
          locationIds: [],
        };
        const translation = translateSpec({ ...spec, filters }, translatorBase, scope);
        if (translation.kind === "deny_stub") {
          throw new Error(
            `report base '${base.baseKey}' MV '${base.mvKey}' is not yet materialized (status='registered') — cannot build a scheduled-run snapshot`,
          );
        }
        // Executes on `db` — which, for this queue, IS the per-job `withOrgContext` tx (see
        // `registerM33Workers`), so the SELECT runs under the requesting tenant's own RLS scope.
        const { rows, rowCount } = await snapshotExecutor.execute(db, {
          sql: translation.sql,
          params: translation.params,
        });
        return {
          snapshotQuery: translation.sql,
          viewId: view.id,
          viewName: view.displayName,
          snapshot: {
            columns: translation.columns.map((c) => ({
              key: c.outputKey,
              sourceKey: c.sourceKey,
              kind: c.kind,
              ...(c.unit ? { unit: c.unit } : {}),
            })),
            rows: rows as Record<string, unknown>[],
            rowCount,
          },
        };
      },
    },
    // BOUND over `deps.outboxPublisher` (the SAME tx-scoped `m33` publisher the write-service command routes
    // already use). Unlike mvRefresh/lagProbe above, every `report.scheduled_run` job carries a real,
    // non-null `organizationId` (§4.8 — this queue is `withOrgContext`-scoped, F09), so
    // `OutboxPublishPort.publish`'s non-null-organizationId contract is satisfied — no infra block here.
    outbox: {
      emitRenderRequested: deps.outboxPublisher
        ? (payload) =>
            deps.outboxPublisher!.publish(db, {
              eventName: "m33.scheduled_report.render_requested",
              payload,
              organizationId: payload.organizationId,
              aggregateKind: "report_schedule_run",
              aggregateId: payload.runId,
            })
        : () =>
            unbound(
              "scheduledRun.outbox.emitRenderRequested",
              "bind `deps.outboxPublisher` (bindCallerModule(txOutboxPublisher, 'm33')) — m33.scheduled_report.render_requested → M22 §1.1",
            ),
      emitFailed: deps.outboxPublisher
        ? (payload) =>
            deps.outboxPublisher!.publish(db, {
              eventName: "m33.scheduled_report.failed",
              payload,
              organizationId: payload.organizationId,
              aggregateKind: "report_schedule_run",
              aggregateId: payload.runId,
            })
        : () =>
            unbound(
              "scheduledRun.outbox.emitFailed",
              "bind `deps.outboxPublisher` (bindCallerModule(txOutboxPublisher, 'm33')) — m33.scheduled_report.failed → M36 warn",
            ),
    },
    // BOUND: ReportScheduleRepository.update already exists and is the write-service's own mechanism for
    // every other schedule mutation — no new repo method needed.
    pause: {
      async autoPause(scheduleId, _reason) {
        await scheduleRepo.update(scheduleId, { status: "paused" });
      },
    },
    // BOUND over the M4 audit() helper (packages/audit) — the SAME sanctioned audit_event writer every
    // module uses; a background job has no acting user, so `userId: null` / `actorKind: "system"` (the M30
    // §4.8 system-sentinel precedent, mirrored here as an explicit audit actor rather than a NULLed GUC —
    // audit() takes its actor from the AuditContext directly, not from a session-scoped `app.user_id`).
    audit: {
      async recordRecipientLostAccess(scheduleId, membershipId) {
        await audit(db, systemAuditContext(deps.jobOrganizationId ?? null), {
          eventType: "m33.scheduled_report.recipient_lost_access",
          resourceKind: "report_schedule",
          resourceId: scheduleId,
          outcome: "success",
          context: { membershipId },
        });
      },
      async recordAllRecipientsRevoked(scheduleId) {
        await audit(db, systemAuditContext(deps.jobOrganizationId ?? null), {
          eventType: "m33.scheduled_report.all_recipients_revoked",
          resourceKind: "report_schedule",
          resourceId: scheduleId,
          outcome: "success",
        });
      },
    },
  };

  // ── report.export_render (withOrgContext) — the PDF/XLSX → M22 render handshake ───────────────────────
  // BOUND: both `exportRender` (this queue) and `scheduledRun` (above) emit the SAME wire event name
  // `m33.scheduled_report.render_requested`, built by two DIFFERENT package producers with two DIFFERENT
  // payload shapes — `ExportRenderRequestPayload` (the ad-hoc PDF/XLSX route path:
  // `exportId/viewId/format/organizationId/snapshotQuery/idempotencyKey/aggregateType/aggregateId`) vs
  // `RunnerOutboxPort`'s payload (the scheduled-run cron path, bound above). The catalog's schema
  // (events-by-m33.ts) marks `scheduleId`/`runId` Optional specifically so BOTH real payload shapes
  // validate — this was a genuine package-level event-catalog gap (one wire name serving two producers, only
  // one of which conformed), fixed at the schema, not by fabricating fields on either payload. Since
  // GAP-051 both also carry an explicit `aggregateType`, because their artifacts are two DIFFERENT
  // `document_aggregate_type`s and M22 resolves the template key from it.
  const exportRenderOutbox: {
    emitRenderRequested(payload: ExportRenderRequestPayload): Promise<void>;
  } = {
    emitRenderRequested: deps.outboxPublisher
      ? (payload) =>
          deps.outboxPublisher!.publish(db, {
            eventName: "m33.scheduled_report.render_requested",
            // Spread + widen: the publisher takes an open record, and a declared interface has no index
            // signature. The catalog still validates every field against the declared TypeBox schema.
            payload: { ...payload } as unknown as Record<string, unknown>,
            organizationId: payload.organizationId,
            aggregateKind: payload.aggregateType,
            aggregateId: payload.aggregateId,
          })
      : () =>
          unbound(
            "exportRender.outbox.emitRenderRequested",
            "bind `deps.outboxPublisher` (bindCallerModule(txOutboxPublisher, 'm33')) — m33.scheduled_report.render_requested → M22 §1.1",
          ),
  };
  const pdf: PdfRenderRequestPorts = { outbox: exportRenderOutbox };
  const xlsx: XlsxRenderRequestPorts = { outbox: exportRenderOutbox };
  const exportRender: ExportRenderProcessorPorts = { pdf, xlsx };

  // ── report.lag_probe (platform; singleton) ───────────────────────────────────────────────────────────
  // BOUND: the `pg_stat_replication` lag sample over the PRIMARY pool. UNBOUND (lazy): the Valkey hysteresis
  // state load/save, the degraded-tile advisory flag, and the §4.9 lag transition emits.
  const lagProbe: LagProbePorts = {
    now,
    replication: {
      async sampleMaxReplayLagSeconds() {
        const res = await primaryDb.execute<{ lag_seconds: number }>(
          sql`SELECT COALESCE(EXTRACT(EPOCH FROM max(replay_lag)), 0)::float8 AS lag_seconds FROM pg_stat_replication`,
        );
        return Number(res.rows[0]?.lag_seconds ?? 0);
      },
    },
    // BOUND: a dedicated Valkey connection (`deps.lagProbeRedis`, see ./lag-probe-state.ts) — the singleton
    // probe's only mutable state (§2.4). Unbound (lazy) when no Redis client is configured, matching every
    // other lazy-bind port here (never a silent no-op — a probe that can't persist its hysteresis state
    // must not pretend it did).
    state: deps.lagProbeRedis
      ? createRedisLagProbeStatePort(deps.lagProbeRedis)
      : {
          load: () =>
            unbound(
              "lagProbe.state.load",
              "bind `deps.lagProbeRedis` (a connected ioredis client) — no Valkey connection configured for the lag-probe state",
            ),
          save: () =>
            unbound(
              "lagProbe.state.save",
              "bind `deps.lagProbeRedis` (a connected ioredis client) — no Valkey connection configured for the lag-probe state",
            ),
        },
    advisory: deps.lagProbeRedis
      ? createRedisLagProbeAdvisoryPort(deps.lagProbeRedis)
      : {
          setAdvisory: () =>
            unbound(
              "lagProbe.advisory.setAdvisory",
              "bind `deps.lagProbeRedis` (a connected ioredis client) — no Valkey connection configured for the degraded-tile advisory flag",
            ),
        },
    // BOUND for real over `deps.outboxPublisher` with `organizationId: null` (the platform-wide-event
    // persist path, migration 0186). The lag probe is an org-agnostic platform SINGLETON —
    // `LagExceededPayload`/`LagRecoveredPayload` carry no natural entity id at all, so `aggregateId` uses
    // a fixed, documented sentinel uuid identifying "the one replica-lag-probe singleton" (not fabricated
    // data — there is genuinely only ever one of these, so a stable identifier for it is correct, not a
    // placeholder standing in for something real that's missing).
    outbox: {
      emitLagExceeded: (payload) =>
        deps.outboxPublisher!.publish(db, {
          eventName: "m33.lag.exceeded",
          payload: { ...payload },
          organizationId: null,
          aggregateKind: "replica_lag_probe",
          aggregateId: LAG_PROBE_SINGLETON_AGGREGATE_ID,
        }),
      emitLagRecovered: (payload) =>
        deps.outboxPublisher!.publish(db, {
          eventName: "m33.lag.recovered",
          payload: { ...payload },
          organizationId: null,
          aggregateKind: "replica_lag_probe",
          aggregateId: LAG_PROBE_SINGLETON_AGGREGATE_ID,
        }),
    },
  };

  // ── report.drilldown_audit_flush (withOrgContext — the requesting tenant, §3.6 F09) ───────────────────
  // BOUND: the insert-only audit append + the id/trace minters. UNBOUND (lazy): the per-tenant envelope-DEK
  // encrypt (fail-closed deny — never plaintext at rest, §3.6) and the §4.10 drilldown emit.
  const drilldownAuditFlush: DrilldownAuditPorts = {
    now,
    newRowId: () => randomUUID(),
    newTraceId: () => randomUUID(),
    encryption: {
      // ★ FAIL-CLOSED: until the M1 envelope-DEK helper is bound, every drilldown audit is DENIED
      //   (DrilldownDekUnavailable) rather than stored un-encrypted — the load-bearing §3.6 invariant.
      encryptFilters: () =>
        unbound(
          "drilldownAuditFlush.encryption.encryptFilters",
          "bind to the M1 per-tenant envelope-DEK encrypt helper (no envelope seam registered yet) — drilldown denies until bound",
        ),
    },
    audit: {
      async append(row) {
        await drilldownRepo.append(row);
      },
    },
    // BOUND over `deps.outboxPublisher`. One deliberate field-name adaptation at THIS wiring boundary (not a
    // package change): the events-by-m33.ts catalog schema for `m33.drilldown.emitted` declares
    // `targetModule` (an integer), but `DrilldownEmittedPayload` (packages/reporting) names the same value
    // `drilldownTargetModule` — the wiring layer's job is exactly this kind of port↔wire adaptation, so the
    // publish payload below is built explicitly with the catalog's field names rather than spreading the
    // port payload as-is (which would fail `Value.Check` on a missing required `targetModule`).
    outbox: {
      emitDrilldown: deps.outboxPublisher
        ? (payload) =>
            deps.outboxPublisher!.publish(db, {
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
            })
        : () =>
            unbound(
              "drilldownAuditFlush.outbox.emitDrilldown",
              "bind `deps.outboxPublisher` (bindCallerModule(txOutboxPublisher, 'm33')) — m33.drilldown.emitted → M36 drilldownConsentNarrowed",
            ),
    },
  };

  // ── report.export.csv (route-streamed; no queue) ─────────────────────────────────────────────────────
  // The direct CSV streamer's row-cursor + writable response sink are supplied per-request by the ROUTE (the
  // chunked HTTP response), not here. The telemetry outbox is the only worker-bag port → lazy-unbound; the
  // route binds source/sink/outbox at call time. Provided so `csvExportProcessor` has a buildable bundle.
  const csvExport: CsvExportPorts = {
    source: {
      fetchChunks: () =>
        unbound(
          "csvExport.source.fetchChunks",
          "bound per-request by the route to a withReportSession 'export'-tier server-side cursor (DECLARE c CURSOR; FETCH 1000)",
        ) as never,
    },
    sink: {
      write: () =>
        unbound(
          "csvExport.sink.write",
          "bound per-request by the route to the chunked HTTP response sink",
        ),
      end: () =>
        unbound(
          "csvExport.sink.end",
          "bound per-request by the route to the chunked HTTP response sink",
        ),
    },
    outbox: {
      emitCsvStreamed: () =>
        unbound(
          "csvExport.outbox.emitCsvStreamed",
          "bind to the live transactional-outbox dispatcher (m33.export.csv_streamed)",
        ),
    },
  };

  return { mvRefresh, scheduledRun, exportRender, lagProbe, drilldownAuditFlush, csvExport };
}

// ── live worker construction (the M34 saas-jobs.ts template) ─────────────────────────────────────────────

/** Fail-closed default when `deps.auditBypass` is absent — a platform-scoped job (mvRefresh/lagProbe) cannot
 *  enter `withPlatformContext` without a real `PlatformBypassAuditor` (every bypass MUST be audited); this
 *  throws only when a platform-scoped job actually RUNS, never at `registerM33Workers` construction (the M34
 *  eager-bind gotcha). */
const FAIL_CLOSED_AUDIT_BYPASS: PlatformBypassAuditor<DbClient> = async () => {
  throw new M33WorkerPortUnbound(
    "platformContext.auditBypass",
    "bind `deps.auditBypass` (the shared m34PlatformBypassAuditor, apps/backend/src/index.ts) — a platform-scoped M33 job cannot enter withPlatformContext without it",
  );
};

/** The system-actor sentinel `withOrgContext`'s tenant-scoped jobs run under — no acting user (the M30 §4.8
 *  precedent; the M4 write-audit trigger NULLIFs an empty user-id GUC). */
const M33_WORKER_SYSTEM_USER_ID = "";

/**
 * Run one `report.mv_refresh` job's PRIMARY-pool body inside an already-open `withPlatformContext` tx
 * (called from the mvRefresh worker below — see its own doc comment for why `mv_refresh` and `nightly-
 * orchestrate` share one queue/worker). Branches on the BullMQ job NAME: `"nightly-orchestrate"` (the cron
 * repeatable `scheduleM33Jobs` registers, carrying no payload) runs the real §2.5 orchestrator
 * (`runNightlyRefresh`), fanning a per-MV refresh job out for every ACTIVE `nightly`-strategy MV through
 * `deps.mvRefreshEnqueue`; any other job name is a fanned-out per-MV refresh (`MvRefreshJob` payload) and
 * runs the per-MV `mvRefreshProcessor`. This is the "dedicated consumer" the original TODO asked for — a
 * sentinel reaching the per-MV processor by mistake would throw `MvRefreshMetadataMissing` (no `mvKey` on
 * its payload), so the branch is load-bearing, not cosmetic.
 */
async function runMvRefreshJob(
  deps: M33WorkerDeps,
  tx: DbClient,
  job: { readonly name: string; readonly data: unknown },
): Promise<unknown> {
  if (job.name === "nightly-orchestrate") {
    const catalogRepo = new ReportCatalogRepository(tx);
    const enqueue =
      deps.mvRefreshEnqueue ??
      ({
        enqueue: () =>
          unbound(
            "nightlyOrchestrate.queue.enqueue",
            "bind `deps.mvRefreshEnqueue` (buildM33MvRefreshEnqueue over a live Valkey connection) — the nightly orchestrator cannot fan per-MV jobs out without a producer",
          ),
      } satisfies MvRefreshQueuePort);
    const ports: NightlyRefreshPorts = {
      metadata: { listActiveByStrategy: (strategy) => catalogRepo.listActiveByStrategy(strategy) },
      queue: enqueue,
      now: deps.now ?? (() => new Date()),
    };
    return runNightlyRefresh(ports);
  }
  const data = job.data as MvRefreshJob;
  return mvRefreshProcessor(buildM33WorkerPorts({ ...deps, db: tx, primaryDb: tx }).mvRefresh)(
    data,
  );
}

/**
 * Construct one BullMQ `Worker` per §4.8 worker-backed queue (mv_refresh / scheduled_run / export_render /
 * drilldown_audit_flush / lag_probe), each driving the matching pure processor INSIDE the tenancy envelope
 * {@link M33_QUEUE_SCOPE} names for that queue (F09) — the SEPARATE integration concern the original TODO
 * left open. `scheduled_run` / `export_render` / `drilldown_audit_flush` are org-scoped: each job opens its
 * own `withOrgContext(job.data.organizationId)` tx and rebuilds the port bundle over it (the M30 §4.8
 * precedent — RLS's `WITH CHECK app.org_id` denies an insert on the un-scoped base client). `mv_refresh` /
 * `lag_probe` are platform-scoped: each opens `withPlatformContext` (audited, allowlist-gated under
 * {@link M33_PLATFORM_JOB_ID}, registered by `wireM33Tenancy()` at boot).
 *
 * Returns the workers so the composition root can `close()` them on shutdown — the caller owns the lifecycle;
 * nothing here runs at import (constructing a Worker is what opens the Valkey connection).
 *
 * The `report.tile_warm_cache` and `report.tenant_eraser` queues are NOT constructed here — NEITHER has any
 * producer anywhere in the backend (no route/outbox-subscriber ever calls `Queue.add` on either name):
 * tile-warming is an unbuilt caching optimization (`dashboard_tile_cache` has zero writers today — reads
 * always compute live), and the REAL tenant-offboarding erase already runs through the M4 destruction-
 * registry `registerReportingErasers` (wired at boot, apps/backend/src/index.ts) — the BullMQ queue name is
 * declared in the §4.8 spec table but was never the actual erase mechanism. Building idle consumers for two
 * queues nothing ever enqueues onto would be dead code, not a real gap closed.
 */
export function registerM33Workers(deps: M33WorkerDeps): Worker[] {
  const { connection } = deps;
  const platformDb = deps.platformDb ?? deps.db;
  const auditBypass = deps.auditBypass ?? FAIL_CLOSED_AUDIT_BYPASS;

  const platformCaller = (reason: string) =>
    ({ jobId: M33_PLATFORM_JOB_ID, reason, crossTenant: true }) as const;

  const mvRefreshWorker = new Worker(
    M33_QUEUES.mvRefresh,
    (job) =>
      withPlatformContext(
        platformDb,
        platformCaller("M33 §2.4/§2.5 MV refresh (per-MV or the nightly orchestrator tick)"),
        auditBypass,
        (tx) => runMvRefreshJob(deps, tx as unknown as DbClient, job),
      ),
    { connection, concurrency: M33_QUEUE_PARAMS.mvRefresh.concurrency },
  );

  const scheduledRunWorker = new Worker(
    M33_QUEUES.scheduledRun,
    (job) => {
      const data = job.data as ScheduledRunJob;
      return withOrgContext(
        deps.db,
        { organizationId: data.organizationId, userId: M33_WORKER_SYSTEM_USER_ID },
        (tx) =>
          scheduledRunProcessor(
            buildM33WorkerPorts({
              ...deps,
              db: tx as unknown as DbClient,
              jobOrganizationId: data.organizationId,
            }).scheduledRun,
          )(data),
      );
    },
    { connection, concurrency: M33_QUEUE_PARAMS.scheduledRun.concurrency },
  );

  const exportRenderWorker = new Worker(
    M33_QUEUES.exportRender,
    (job) => {
      const data = job.data as ExportRenderJob;
      return withOrgContext(
        deps.db,
        { organizationId: data.organizationId, userId: M33_WORKER_SYSTEM_USER_ID },
        (tx) =>
          exportRenderProcessor(
            buildM33WorkerPorts({ ...deps, db: tx as unknown as DbClient }).exportRender,
          )(data),
      );
    },
    { connection, concurrency: M33_QUEUE_PARAMS.exportRender.concurrency },
  );

  const drilldownAuditFlushWorker = new Worker(
    M33_QUEUES.drilldownAuditFlush,
    (job) => {
      const data = job.data as DrilldownAuditInput;
      return withOrgContext(
        deps.db,
        { organizationId: data.organizationId, userId: M33_WORKER_SYSTEM_USER_ID },
        (tx) =>
          drilldownAuditFlushProcessor(
            buildM33WorkerPorts({ ...deps, db: tx as unknown as DbClient }).drilldownAuditFlush,
          )(data),
      );
    },
    { connection, concurrency: M33_QUEUE_PARAMS.drilldownAuditFlush.concurrency },
  );

  const lagProbeWorker = new Worker(
    M33_QUEUES.lagProbe,
    (job) =>
      withPlatformContext(
        platformDb,
        platformCaller("M33 §2.4/D14 replica-lag probe tick"),
        auditBypass,
        (tx) =>
          lagProbeProcessor(
            buildM33WorkerPorts({ ...deps, db: tx as unknown as DbClient }).lagProbe,
          )(job.data as LagProbeJob),
      ),
    { connection, concurrency: M33_QUEUE_PARAMS.lagProbe.concurrency },
  );

  return [
    mvRefreshWorker,
    scheduledRunWorker,
    exportRenderWorker,
    drilldownAuditFlushWorker,
    lagProbeWorker,
  ];
}

/**
 * Build the `report.mv_refresh` producer the nightly orchestrator (`runMvRefreshJob` above) fans per-MV
 * refresh jobs out onto — a SEPARATE `Queue` handle from the one `registerM33Workers`' `mvRefreshWorker`
 * consumes (a producer needs its own `Queue.add`; a `Worker` only consumes). Fails closed (no silent no-op)
 * when no Valkey connection is configured — mirrors `buildM33ReadEnqueue` (wiring.ts).
 *
 * SANITIZES the dispatcher's jobId (`mv_refresh:<mvKey>:<floorEpochMs>`, packages/reporting's
 * `dispatcher.ts` `mvRefreshJobId`) by replacing `:` with `__` — BullMQ rejects a custom jobId containing
 * `:` (`Error: Custom Id cannot contain :`), the SAME bug class WX-PR-013/WX-PR-014 found and fixed in the
 * M27/M30 recompute producers. The sanitization is deterministic (identical input → identical output), so
 * the §2.6 debounce-collapse dedup property is preserved.
 */
export function buildM33MvRefreshEnqueue(connection: ConnectionOptions | undefined): {
  readonly enqueue: MvRefreshQueuePort;
  readonly queue: Queue | null;
} {
  if (!connection) {
    return {
      enqueue: {
        enqueue: () =>
          unbound(
            "mvRefreshEnqueue.enqueue",
            "no Valkey connection configured — cannot enqueue onto report.mv_refresh (set the queue connection at boot)",
          ),
      },
      queue: null,
    };
  }
  const queue = new Queue(M33_QUEUES.mvRefresh, { connection });
  const enqueue: MvRefreshQueuePort = {
    async enqueue(job, opts): Promise<MvRefreshEnqueueOutcome> {
      const jobId = opts.jobId.replace(/:/g, "__");
      const existing = await queue.getJob(jobId);
      if (existing) return { enqueued: false, jobId };
      await queue.add(M33_QUEUES.mvRefresh, job, {
        jobId,
        delay: opts.debounceMs,
        removeOnComplete: { count: 200 },
        removeOnFail: false,
      });
      return { enqueued: true, jobId };
    },
  };
  return { enqueue, queue };
}

/**
 * Register the two §4.8 repeatable cron schedules: the 30-second replica-lag probe (on `report.lag_probe`,
 * consumed by the lag-probe worker `registerM33Workers` builds) and the nightly MV-refresh orchestrator tick
 * (02:00 tenant-local, on `report.mv_refresh`, job name `"nightly-orchestrate"` — the `mvRefreshWorker`
 * above branches on this exact name to run the real orchestrator instead of the per-MV processor). Returns
 * the schedule `Queue`s so the composition root can `close()` them. Mirrors `scheduleM34Jobs` (the
 * repeatable-registration template): one `Queue` per cron, `add('scheduled'|'nightly-orchestrate', {},
 * { repeat: { … } })`.
 */
export async function scheduleM33Jobs(connection: ConnectionOptions): Promise<Queue[]> {
  const lagProbe = new Queue(M33_QUEUES.lagProbe, { connection });
  const mvRefreshNightly = new Queue(M33_QUEUES.mvRefresh, { connection });
  await lagProbe.add(
    "scheduled",
    {},
    { repeat: { every: M33_JOB_SCHEDULES.lagProbeEveryMs }, removeOnComplete: true },
  );
  await mvRefreshNightly.add(
    "nightly-orchestrate",
    {},
    { repeat: { pattern: M33_JOB_SCHEDULES.mvRefreshNightly }, removeOnComplete: true },
  );
  return [lagProbe, mvRefreshNightly];
}

/** Build the {@link M33WorkerDeps} from the composition-root primitives (the M34 `buildM34WorkerDeps` shape). */
export function buildM33WorkerDeps(deps: {
  connection: ConnectionOptions;
  db: DbClient;
  primaryDb?: DbClient;
  platformDb?: DbClient;
  auditBypass?: PlatformBypassAuditor<DbClient>;
  outboxPublisher?: M33WorkerDeps["outboxPublisher"];
  lagProbeRedis?: Redis;
  mvRefreshEnqueue?: MvRefreshQueuePort;
  now?: () => Date;
}): M33WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    primaryDb: deps.primaryDb,
    platformDb: deps.platformDb,
    auditBypass: deps.auditBypass,
    outboxPublisher: deps.outboxPublisher,
    lagProbeRedis: deps.lagProbeRedis,
    mvRefreshEnqueue: deps.mvRefreshEnqueue,
    now: deps.now ?? (() => new Date()),
  };
}

// WX-PR-014 (M33 slice) closed:
//   • the tenancy envelope (withOrgContext / withPlatformContext per M33_QUEUE_SCOPE) — EVERY M33 worker ran
//     on the un-scoped base client before this; FORCE RLS silently denied/empty'd every org-scoped write/read.
//   • the nightly MV-refresh orchestrator — the cron sentinel used to land directly on the per-MV worker
//     (job.name mismatch never checked); now branches to the real `runNightlyRefresh` fan-out.
//   • the scheduled_run / export_render / drilldown_audit_flush / mvRefresh / lagProbe outbox emits — ALL
//     nine now bind for real over `deps.outboxPublisher`, `scheduledRun.recipients` (M2 active-membership
//     re-validation), `scheduledRun.snapshot.build` (the real translateSpec chain), `scheduledRun.
//     pause.autoPause`, `scheduledRun.audit.*` (the M4 audit() helper), the Valkey-backed `lagProbe.state`/
//     `lagProbe.advisory`, and `mvRefresh.tileCache.invalidateForMv`'s org=null no-op.
//   • the same BullMQ "jobId cannot contain ':'" bug class (WX-PR-013/014) in the new nightly-orchestrator
//     producer (`buildM33MvRefreshEnqueue`).
//   • (follow-up pass, same day) the M1 nullable-organizationId outbox persist path: `outbox_event.
//     organization_id` is now nullable, gated by a NEW SECURITY DEFINER writer surface (migration 0186,
//     `report_writer_*` functions — the `wardenx_audit_writer`/`audit_writer_insert` precedent, NOT a
//     second RLS-policy GUC — ADR-0010 D2 bans any session variable beyond `app.org_id`, so a policy keyed
//     on a new GUC was reverted and replaced with this role+function pattern instead). The dispatcher
//     (apps/backend/src/bootstrap/outbox-dispatcher.ts) gained an additive `pollPlatform()` pass over the
//     same functions — `mvRefresh`/`lagProbe`'s outbox emits are genuinely live now, not just unblocked in
//     theory (their `aggregateId` resolves the real `materialized_view_metadata.id` uuid / a fixed
//     lag-probe-singleton sentinel uuid, since `outbox_event.aggregate_id` is a real uuid column and
//     neither `mvKey` nor "the one lag probe" naturally is one).
//   • (follow-up pass) `exportRender.outbox.emitRenderRequested` — the `m33.scheduled_report.
//     render_requested` catalog schema now marks `scheduleId`/`runId` Optional so both real producer
//     payloads (the cron path's + the ad-hoc export path's) validate; bound for real.
//
// Still explicitly OUT OF SCOPE (genuine gaps, not silently routed around):
//   • `drilldownAuditFlush.encryption.encryptFilters` — still blocked on the M1 envelope-DEK/KMS provider,
//     which does not exist anywhere in the codebase yet (same as WX-PR-013/014's M23/M30 CAHPS-PHI gap).
//   • `scheduledRun.snapshot.build`'s returned `snapshotQuery` still carries unresolved `$1, $2, …`
//     placeholders with no params channel in the wire event — a pre-existing package/event-schema gap, not
//     introduced here (M22's eventual render consumer will need a fix before it can execute this query).
//   • `report.tile_warm_cache` / `report.tenant_eraser` — no producer anywhere; the real tenant-erase path is
//     the M4 destruction registry (already wired), and tile-warming is an unbuilt caching optimization.
//   • the M33 cron-parser adapter (`FAIL_CLOSED_CRON` in wiring.ts) — schedule create/update `next_run_at`
//     math is a separate library integration, out of the §4.8 background-job charter this task covers.
//   • no M33 self-invalidate / M36 alert CONSUMER is registered yet for `m33.mv.*`/`m33.lag.*` — the events
//     now persist durably (this pass's whole point) and correctly report "deferred" pending a consumer, but
//     `pollPlatform()` deliberately does not deliver to `deps.consumers` (the shared `DispatchableOutboxEvent`
//     type is non-null-organizationId, used by ~150 existing org-scoped bindings — widening it, or adding a
//     parallel `PlatformOutboxConsumerBinding` type, was out of scope for this pass). Building the actual
//     consumer logic for these two event families is separate work.
//
// TWO GENUINE, SEVERE, PRE-EXISTING BUGS DISCOVERED WHILE VERIFYING THIS FIX UNDER REAL RLS (found via
// direct `psql`, `SET ROLE wardenx_app`, NOBYPASSRLS — this codebase's own `rls-isolation.live.test.ts`
// precedent; a superuser test connection, this pass's OWN first draft included, bypasses RLS entirely and
// proves nothing about it). NEITHER is fixed by this pass — both are pre-existing, orthogonal to the
// outbox emits this task was asked to close, and each is its own, comparably-sized fix:
//   1. `report_run` (this file's `runs.open`/`runs.settle`, called by every mvRefresh job) and
//     `materialized_view_metadata` (`metadataWrite.stamp`) have the IDENTICAL "no wardenx_app RLS policy
//     admits a platform-wide (organizationId IS NULL / no-org) write" gap this pass fixed for
//     `outbox_event` (migration 0186) — `report_run.organization_id` has been documented nullable since
//     M33 shipped ("cross-tenant platform-wide refreshes"), but no SECURITY DEFINER writer path was ever
//     built for it, so this INSERT has never once succeeded under real (non-BYPASSRLS) RLS. Confirmed:
//     `SET ROLE wardenx_app; INSERT INTO report_run (..., organization_id, ...) VALUES (..., NULL, ...)`
//     → `ERROR: new row violates row-level security policy for table "report_run"`. In today's
//     production posture this means `handleMvRefresh` throws on its OWN run-ledger open, before ever
//     reaching this pass's outbox fix — this test's `platformDb: seedDb.db` (superuser) works around it
//     for the test only; production is NOT worked around.
//   2. `withPlatformContext` (packages/tenancy/src/context.ts) calls its injected `auditBypass` (the
//     shared `m34PlatformBypassAuditor`, apps/backend/src/index.ts) UNCONDITIONALLY on every entry, and
//     THAT writes a `platform.bypass_invoked` audit_event row with `organizationId: null` — but
//     `audit_event`'s ONLY null-org write path is `audit_writer_insert FOR INSERT TO wardenx_audit_writer`
//     (a role `wardenx_app` does not hold), and migration 0119's own org-scoped fix
//     (`audit_event_org_append`) explicitly excludes null-org rows by design ("Platform-scoped rows...
//     must continue to go through the M34 bypass auditor under withPlatformContext" — but nothing ever
//     built that role/policy path for the auditor itself). Confirmed: `SET ROLE wardenx_app; INSERT INTO
//     audit_event (organization_id, ...) VALUES (NULL, ...)` → the identical RLS violation. Since EVERY
//     `withPlatformContext` call in the ENTIRE codebase (not just M33 — M7/M9/M10/M25/M27/M30/M33/M34 and
//     beyond) executes this same audit write as its first unconditional step, this means EVERY
//     `withPlatformContext` call throws under a properly-hardened, NOBYPASSRLS production deployment
//     today — a severe, previously-undiscovered, codebase-wide bug, not an M33-scoped one. This pass's own
//     live test only avoids hitting it because `platformDb: seedDb.db` (superuser) sidesteps it the same
//     way as finding #1. Reported to the user directly, not silently fixed inline — the fix (an
//     `audit_event` SECURITY DEFINER platform-write path, mirroring `outbox_event`'s migration 0186) is a
//     foundational M1/M34 change with a much larger blast radius than this task's charter.
