import type { DbClient } from "@wardenx/db";
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
import {
  type CsvExportPorts,
  DashboardTileCacheRepository,
  type DrilldownAuditPorts,
  type LagProbePorts,
  type MvRefreshWorkerPorts,
  type PdfRenderRequestPorts,
  ReportCatalogRepository,
  ReportDrilldownAuditRepository,
  ReportRunRepository,
  ReportScheduleRepository,
  type ScheduledRunPorts,
  type XlsxRenderRequestPorts,
} from "@wardenx/reporting";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  type ExportRenderProcessorPorts,
  M33_JOB_SCHEDULES,
  M33_QUEUE_PARAMS,
  M33_QUEUES,
  drilldownAuditFlushProcessor,
  exportRenderProcessor,
  lagProbeProcessor,
  mvRefreshProcessor,
  scheduledRunProcessor,
} from "./index";

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
  /** Injected clock (deterministic in tests; the package workers stamp every instant through this). */
  now?: () => Date;
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
      // (org=null) needs a `deleteByMvKey` the repo does not expose yet → lazy-unbound (fail-closed, not no-op).
      async invalidateForMv({ organizationId }) {
        if (organizationId === null) {
          return unbound(
            "mvRefresh.tileCache.invalidateForMv",
            "DashboardTileCacheRepository has no deleteByMvKey for the platform-global (org=null) refresh yet",
          );
        }
        return tileRepo.deleteByOrg(organizationId);
      },
    },
    outbox: {
      emitRefreshSucceeded: () =>
        unbound(
          "mvRefresh.outbox.emitRefreshSucceeded",
          "bind to the live transactional-outbox dispatcher (m33.mv.refresh_succeeded)",
        ),
      emitRefreshFailed: () =>
        unbound(
          "mvRefresh.outbox.emitRefreshFailed",
          "bind to the live transactional-outbox dispatcher (m33.mv.refresh_failed → M36 warn)",
        ),
      emitRefreshExhausted: () =>
        unbound(
          "mvRefresh.outbox.emitRefreshExhausted",
          "bind to the live transactional-outbox dispatcher (m33.mv.refresh_exhausted → M36 critical)",
        ),
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
    recipients: {
      isRecipientEntitled: () =>
        unbound(
          "scheduledRun.recipients.isRecipientEntitled",
          "bind to getSeam('ConsentEvaluator').evaluateForReporting + the M2 active-membership reader (W-R-04 re-validation)",
        ),
    },
    snapshot: {
      build: () =>
        unbound(
          "scheduledRun.snapshot.build",
          "bind to the M33 report-builder translator over a withReportSession replica session (the saved view's spec → SELECT)",
        ),
    },
    outbox: {
      emitRenderRequested: () =>
        unbound(
          "scheduledRun.outbox.emitRenderRequested",
          "bind to the live transactional-outbox dispatcher (m33.scheduled_report.render_requested → M22 §1.1)",
        ),
      emitFailed: () =>
        unbound(
          "scheduledRun.outbox.emitFailed",
          "bind to the live transactional-outbox dispatcher (m33.scheduled_report.failed → M36 warn)",
        ),
    },
    pause: {
      autoPause: () =>
        unbound(
          "scheduledRun.pause.autoPause",
          "bind to ReportScheduleRepository.update(status='paused') under withOrgContext (§2.5 all-revoked)",
        ),
    },
    audit: {
      recordRecipientLostAccess: () =>
        unbound("scheduledRun.audit.recordRecipientLostAccess", "bind to the M4 audit() helper (§164.528)"),
      recordAllRecipientsRevoked: () =>
        unbound("scheduledRun.audit.recordAllRecipientsRevoked", "bind to the M4 audit() helper (§164.528)"),
    },
  };

  // ── report.export_render (withOrgContext) — the PDF/XLSX → M22 render handshake ───────────────────────
  // Both formats emit `m33.scheduled_report.render_requested` through the live outbox; UNBOUND (lazy) until
  // the dispatcher lands. The PDF row gate runs inside `requestPdfRender` before the emit (fail-closed 413).
  const exportRenderOutbox = {
    emitRenderRequested: () =>
      unbound(
        "exportRender.outbox.emitRenderRequested",
        "bind to the live transactional-outbox dispatcher (m33.scheduled_report.render_requested → M22 PDF/XLSX)",
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
    state: {
      load: () =>
        unbound(
          "lagProbe.state.load",
          "bind to the Valkey-backed lag-probe hysteresis state (the singleton's only mutable state)",
        ),
      save: () =>
        unbound("lagProbe.state.save", "bind to the Valkey-backed lag-probe hysteresis state"),
    },
    advisory: {
      setAdvisory: () =>
        unbound(
          "lagProbe.advisory.setAdvisory",
          "bind to the Valkey degraded-tile advisory flag (D14 — the tile 'Data as of' badge)",
        ),
    },
    outbox: {
      emitLagExceeded: () =>
        unbound(
          "lagProbe.outbox.emitLagExceeded",
          "bind to the live transactional-outbox dispatcher (m33.lag.exceeded → M1 system_status + M36 warn)",
        ),
      emitLagRecovered: () =>
        unbound(
          "lagProbe.outbox.emitLagRecovered",
          "bind to the live transactional-outbox dispatcher (m33.lag.recovered → M1 system_status + M36 info)",
        ),
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
    outbox: {
      emitDrilldown: () =>
        unbound(
          "drilldownAuditFlush.outbox.emitDrilldown",
          "bind to the live transactional-outbox dispatcher (m33.drilldown.* → M36 drilldownConsentNarrowed)",
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
        unbound("csvExport.sink.write", "bound per-request by the route to the chunked HTTP response sink"),
      end: () =>
        unbound("csvExport.sink.end", "bound per-request by the route to the chunked HTTP response sink"),
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

/**
 * Construct one BullMQ `Worker` per §4.8 worker-backed queue (mv_refresh / scheduled_run / export_render /
 * drilldown_audit_flush / lag_probe), each driving the matching pure processor with the bound ports. Returns
 * the workers so the composition root can `close()` them on shutdown — the caller owns the lifecycle; nothing
 * here runs at import (constructing a Worker opens the Valkey connection, which must happen only in production
 * wiring, never in tests).
 *
 * The per-job tenancy envelope (withReportSession / withOrgContext / withPlatformContext per
 * {@link M33_QUEUE_SCOPE}) is the SEPARATE integration concern: the ports built above expect to be invoked
 * inside that envelope, so the integrator either wraps the processor body or threads a per-job scoped DB
 * handle. This function constructs the worker shells; binding the envelope + supplying the still-missing infra
 * seams is the integrator's remaining step (the typed throws above name each missing seam).
 *
 * The `report.tile_warm_cache` and `report.tenant_eraser` workers are NOT constructed here — tile-warming is a
 * thin `DashboardTileCacheRepository.upsert` the integrator binds, and the offboarding erase is driven through
 * the M4 destruction-registry eraseFn (`registerM33Erasers`), not a standalone package worker. They land with
 * those deps (the M34 precedent — the sweep workers scheduled but constructed alongside their per-run inputs).
 */
export function registerM33Workers(deps: M33WorkerDeps): Worker[] {
  const ports = buildM33WorkerPorts(deps);
  const { connection } = deps;
  const mk = <D, R>(
    queue: string,
    processor: (data: D) => Promise<R>,
    concurrency: number,
  ): Worker => new Worker(queue, async (job) => processor(job.data as D), { connection, concurrency });

  return [
    mk(M33_QUEUES.mvRefresh, mvRefreshProcessor(ports.mvRefresh), M33_QUEUE_PARAMS.mvRefresh.concurrency),
    mk(
      M33_QUEUES.scheduledRun,
      scheduledRunProcessor(ports.scheduledRun),
      M33_QUEUE_PARAMS.scheduledRun.concurrency,
    ),
    mk(
      M33_QUEUES.exportRender,
      exportRenderProcessor(ports.exportRender),
      M33_QUEUE_PARAMS.exportRender.concurrency,
    ),
    mk(
      M33_QUEUES.drilldownAuditFlush,
      drilldownAuditFlushProcessor(ports.drilldownAuditFlush),
      M33_QUEUE_PARAMS.drilldownAuditFlush.concurrency,
    ),
    mk(M33_QUEUES.lagProbe, lagProbeProcessor(ports.lagProbe), M33_QUEUE_PARAMS.lagProbe.concurrency),
  ];
}

/**
 * Register the two §4.8 repeatable cron schedules: the 30-second replica-lag probe (on `report.lag_probe`,
 * consumed by the lag-probe worker `registerM33Workers` builds) and the nightly MV-refresh orchestrator tick
 * (02:00 tenant-local, on `report.mv_refresh`). Returns the schedule `Queue`s so the composition root can
 * `close()` them. Mirrors `scheduleM34Jobs` (the repeatable-registration template): one `Queue` per cron,
 * `add('scheduled', {}, { repeat: { … } })`.
 *
 * TODO(integrator): the nightly repeatable enqueues a SENTINEL tick onto `report.mv_refresh` — its intended
 * consumer is the §2.5 nightly ORCHESTRATOR (`runNightlyRefresh`, which fans a per-MV `report.mv_refresh` job
 * out across the active nightly-strategy MVs through the `MvRefreshQueuePort` producer), NOT the per-MV
 * refresh worker built above (that handles the fanned-out per-MV jobs). Wire the orchestrator on a dedicated
 * consumer before this fires in prod; until then a sentinel that reaches the per-MV worker fails closed
 * (MvRefreshMetadataMissing → DLQ), never a silent mis-refresh.
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
}): M33WorkerDeps {
  return {
    connection: deps.connection,
    db: deps.db,
    primaryDb: deps.primaryDb,
    now: () => new Date(),
  };
}

// TODO(integrator — the still-missing infra seams the typed throws above name):
//   • the live transactional-outbox dispatcher accessor (every `emit*` / `publishOutbox` port) — bind it and
//     the MV-refresh / scheduled-run / export-render / lag-probe / drilldown emits light up.
//   • the M1 envelope-DEK encrypt helper (the drilldown `encryption` port) — until bound, drilldown audit
//     fails closed (DrilldownDekUnavailable); register it in bootstrap/seams so `getSeam` resolves it.
//   • the M39 `ConsentEvaluator.evaluateForReporting` + the M2 active-membership reader (the scheduled-run
//     `recipients` re-validation, W-R-04) and the report-builder translator (`snapshot.build`).
//   • the Valkey-backed lag-probe hysteresis state + the degraded-tile advisory flag (the `lagProbe.state` /
//     `lagProbe.advisory` ports, D14).
//   • the dedicated primary pool (`deps.primaryDb`) + registering the M33 platform jobIds in the
//     @wardenx/tenancy PLATFORM_CONTEXT_ALLOWLIST so withPlatformContext admits the refresh/probe/eraser jobs.
//   • the report.tile_warm_cache + report.tenant_eraser Workers (the tile-cache upsert / the M4 eraseFn) and
//     the nightly MV-refresh orchestrator consumer — built alongside `registerM33Workers` once their deps land.
//   • wrap each processor body (or thread a per-job scoped DB handle) in withReportSession/withOrgContext/
//     withPlatformContext per M33_QUEUE_SCOPE (F09) before mounting — `registerM33Workers` builds the shells.
