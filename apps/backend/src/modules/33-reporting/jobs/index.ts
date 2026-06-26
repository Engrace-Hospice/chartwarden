// apps/backend/src/modules/33-reporting/jobs — M33 background jobs (Phase 2C, §4.8). The PURE catalog
// (queue names / params / schedules / DLQ / idempotency keys) + the pure processor closures that wrap each
// §2 worker over its injected ports — pure data + thin closures, NO `bullmq` import (the live `Worker`/`Queue`
// construction binds at app boot in `m33-jobs.ts`, the M4-T11 `audit-jobs.ts` / M34 `saas-jobs.ts` pattern).
// The job LOGIC all lives in @wardenx/reporting (unit-tested against in-memory ports); this file only NAMES
// the queues and adapts `(job.data, ports) → worker(job.data, ports)`.
//
// §4.8 queues (the spec table, verbatim wire names): report.mv_refresh · report.scheduled_run ·
// report.export_render · report.tile_warm_cache · report.drilldown_audit_flush · report.lag_probe ·
// report.tenant_eraser. Two of those carry cron repeatables (the nightly MV-refresh orchestrator tick at
// 02:00 tenant-local + the 30-second replica-lag probe); the rest are enqueued on demand by routes /
// outbox-subscriptions.
//
// Each pure processor is the body a `Worker(queue, processor, { connection })` runs: it takes the bound
// worker ports (assembled per-queue by the live wiring so the run sits inside the right
// withReportSession / withOrgContext / withPlatformContext envelope, F09) and the job payload, and delegates
// to the package worker. No clock/RNG/DB/BullMQ here, so the catalog stays unit-assertable and import-safe.
import type {
  CsvExportPorts,
  CsvExportRequest,
  CsvExportResult,
  DrilldownAuditInput,
  DrilldownAuditPorts,
  DrilldownAuditResult,
  ExportRenderFormat,
  ExportRenderRequestInput,
  ExportRenderRequestResult,
  LagProbePorts,
  LagProbeReport,
  MvRefreshJob,
  MvRefreshResult,
  MvRefreshWorkerPorts,
  PdfRenderRequestPorts,
  ScheduledRunJob,
  ScheduledRunPorts,
  ScheduledRunResult,
  XlsxRenderRequestPorts,
} from "@wardenx/reporting";
import {
  handleCsvExport,
  handleMvRefresh,
  handleScheduledRun,
  requestPdfRender,
  requestXlsxRender,
  runLagProbe,
  writeDrilldownAudit,
} from "@wardenx/reporting";

// ── §4.8 queue catalog (spec-literal `report.*`; the scheduler binds the cron repeatables at boot) ─────

/** The §4.8 BullMQ queue names (verbatim from the spec §4.8 table). The command/work queues are enqueued on
 *  demand by the report routes / the §4.5 outbox-subscription map; `report.lag_probe` + the nightly tick on
 *  `report.mv_refresh` are cron repeatables ({@link M33_JOB_SCHEDULES}). */
export const M33_QUEUES = {
  /** `report.mv_refresh` — REFRESH MATERIALIZED VIEW CONCURRENTLY on the PRIMARY + W-R-06 alert gate (§2.4). */
  mvRefresh: "report.mv_refresh",
  /** `report.scheduled_run` — one due occurrence `queued → running → rendered_pending` + recipient re-validation (§2.2). */
  scheduledRun: "report.scheduled_run",
  /** `report.export_render` — the PDF/XLSX export → M22 §1.1 render handshake (CSV streams direct, no queue, §4.8). */
  exportRender: "report.export_render",
  /** `report.tile_warm_cache` — warm the sha256-keyed `dashboard_tile_cache` for a dashboard's tiles (§2.x). */
  tileWarmCache: "report.tile_warm_cache",
  /** `report.drilldown_audit_flush` — envelope-encrypt + insert-only `report_drilldown_audit` + emit (W-R-05). */
  drilldownAuditFlush: "report.drilldown_audit_flush",
  /** `report.lag_probe` — the 30s singleton replica-lag probe + the two-probe hysteresis (§2.4 / D14). */
  lagProbe: "report.lag_probe",
  /** `report.tenant_eraser` — the M4 destruction-registry tenant-offboarding erase of operational rows (§3.7). */
  tenantEraser: "report.tenant_eraser",
} as const;

export type M33QueueName = (typeof M33_QUEUES)[keyof typeof M33_QUEUES];

/** The §4.8 dead-letter queue names (OPS document-before-clear; ops alerts off DLQ depth). One per queue. */
export const M33_DLQ = {
  mvRefresh: "report.mv_refresh.dlq",
  scheduledRun: "report.scheduled_run.dlq",
  exportRender: "report.export_render.dlq",
  tileWarmCache: "report.tile_warm_cache.dlq",
  drilldownAuditFlush: "report.drilldown_audit_flush.dlq",
  lagProbe: "report.lag_probe.dlq",
  tenantEraser: "report.tenant_eraser.dlq",
} as const;

/**
 * The §4.8 cron cadences the scheduler registers as BullMQ repeatables. Only TWO M33 queues are scheduled —
 * the rest are enqueued on demand (routes / the §4.5 incremental outbox-subscription map):
 *   - the NIGHTLY MV-refresh orchestrator tick (02:00 tenant-local) which fans `report.mv_refresh` jobs out
 *     across the active `nightly`-strategy MVs (§2.5 / `nightly-cron.ts` `NIGHTLY_REFRESH_CRON`);
 *   - the 30-second replica-lag probe singleton (§2.4 / D14 — sub-minute so it carries an `everyMs`, not a cron).
 */
export const M33_JOB_SCHEDULES = {
  /** Nightly MV-refresh orchestrator tick — 02:00 tenant-local (§2.5 / §4.8). */
  mvRefreshNightly: "0 2 * * *",
  /** Replica-lag probe singleton — every 30s (§2.4 / D14; sub-minute, so an interval not a cron pattern). */
  lagProbeEveryMs: 30_000,
} as const;

/**
 * The §4.8 BullMQ standard parameter set per queue (the §4.8 `Worker concurrency` column + the attempts/backoff
 * floor), declared as pure data so the boot-time `Worker` construction consumes one source of truth.
 * `removeOnFail:false` keeps exhausted jobs for DLQ promotion. The drilldown-audit flush carries the highest
 * retry budget (the audit MUST land); the lag probe is a concurrency-1 singleton (never parallel).
 */
export const M33_QUEUE_PARAMS = {
  mvRefresh: {
    priority: 3,
    attempts: 5, // §4.8 — 30s/2m/10m/30m/2h backoff; exhaustion suspends the MV + emits m33.mv.refresh_exhausted
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 2,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
    dlq: M33_DLQ.mvRefresh,
  },
  scheduledRun: {
    priority: 4,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 4,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
    dlq: M33_DLQ.scheduledRun,
  },
  exportRender: {
    priority: 4,
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    concurrency: 4,
    removeOnComplete: { count: 200 },
    removeOnFail: false,
    dlq: M33_DLQ.exportRender,
  },
  tileWarmCache: {
    priority: 6,
    attempts: 2,
    backoff: { type: "fixed", delay: 10_000 },
    concurrency: 8, // cache warming is cheap + parallel-safe (sha256-keyed upsert, idempotent)
    removeOnComplete: { count: 100 },
    removeOnFail: false,
    dlq: M33_DLQ.tileWarmCache,
  },
  drilldownAuditFlush: {
    priority: 2, // the compliance audit row MUST land — high priority, generous retries
    attempts: 5,
    backoff: { type: "exponential", delay: 15_000 },
    concurrency: 4,
    removeOnComplete: { count: 500 },
    removeOnFail: false,
    dlq: M33_DLQ.drilldownAuditFlush,
  },
  lagProbe: {
    priority: 5,
    attempts: 1, // a probe tick that fails just retries on the next 30s repeatable — no per-tick retries
    backoff: { type: "fixed", delay: 30_000 },
    concurrency: 1, // §2.4 — the singleton probe is never run in parallel (the hysteresis state is serial)
    removeOnComplete: { count: 50 },
    removeOnFail: { count: 50 },
    dlq: M33_DLQ.lagProbe,
  },
  tenantEraser: {
    priority: 1, // the irreversible offboarding erase — highest priority, single-flight per org
    attempts: 3,
    backoff: { type: "exponential", delay: 60_000 },
    concurrency: 1,
    removeOnComplete: { count: 500 },
    removeOnFail: false,
    dlq: M33_DLQ.tenantEraser,
  },
} as const;

// ── §4.8 idempotency keys (the BullMQ jobId / §2.6 dedup oracles the spec declares) ────────────────────

/** `report.mv_refresh` jobId — per `(mvKey, requestedAtFloor)` (§2.6 debounce dedup; a redelivery collides). */
export function mvRefreshJobId(input: { mvKey: string; floorEpochMs: number }): string {
  return `mv_refresh:${input.mvKey}:${input.floorEpochMs}`;
}

/** `report.scheduled_run` jobId — per `(scheduleId, scheduledFor)` (§2.6 at-most-once per occurrence). */
export function scheduledRunJobId(input: { scheduleId: string; scheduledFor: string }): string {
  return `scheduled_run:${input.scheduleId}:${input.scheduledFor}`;
}

/** `report.export_render` jobId — per `exportId` (§2.6 — = the M22 render-handshake idempotencyKey). */
export function exportRenderJobId(exportId: string): string {
  return `export_render:${exportId}`;
}

/** `report.tile_warm_cache` jobId — per `(organizationId, tileCacheKey)` (the sha256 tile key dedups warms). */
export function tileWarmCacheJobId(input: { organizationId: string; tileCacheKey: string }): string {
  return `tile_warm_cache:${input.organizationId}:${input.tileCacheKey}`;
}

/** `report.drilldown_audit_flush` jobId — per `drilldownTraceId` (one audit row per emitted navigation). */
export function drilldownAuditFlushJobId(drilldownTraceId: string): string {
  return `drilldown_audit_flush:${drilldownTraceId}`;
}

/** `report.lag_probe` jobId — the fixed singleton key (only one probe is ever in flight, §2.4). */
export function lagProbeJobId(): string {
  return "lag_probe:singleton";
}

/** `report.tenant_eraser` jobId — per `organizationId` (single-flight per offboarding org, §3.7). */
export function tenantEraserJobId(organizationId: string): string {
  return `tenant_eraser:${organizationId}`;
}

// ── the per-org/platform scoping envelope the live wiring runs each processor inside ───────────────────

/**
 * The tenancy envelope a job runs inside. The live wiring resolves the scope per queue and wraps the
 * port-binding + the package-worker call in the matching @wardenx/tenancy / @wardenx/reporting context (F09):
 *   - `org`      → `withReportSession` (read-replica reads) or `withOrgContext` (org-scoped writes) — the
 *                  scheduled-run / export-render / tile-warm / drilldown-audit jobs scope to the REQUESTING
 *                  tenant's RLS (never platform bypass).
 *   - `platform` → `withPlatformContext` — the MV-refresh (PRIMARY, nullable-org global MV), the lag probe,
 *                  and the tenant-offboarding eraser run on the audited cross-tenant / org-agnostic path.
 * This catalog only NAMES the required scope per queue ({@link M33_QUEUE_SCOPE}); the live wiring owns the
 * actual context call (mechanism), so the pure catalog stays infra-free.
 */
export type M33JobScope = "org" | "platform";

/** The required tenancy envelope per queue (the live wiring wraps each processor accordingly, F09). */
export const M33_QUEUE_SCOPE: Record<M33QueueName, M33JobScope> = {
  [M33_QUEUES.mvRefresh]: "platform", // §2.4 — REFRESH on the PRIMARY; the report_mv views are platform-global (org=null)
  [M33_QUEUES.scheduledRun]: "org", // the requesting tenant's RLS (recipients re-validated under withOrgContext)
  [M33_QUEUES.exportRender]: "org",
  [M33_QUEUES.tileWarmCache]: "org",
  [M33_QUEUES.drilldownAuditFlush]: "org", // §3.6 F09 — the insert-only audit row under the tenant's withOrgContext
  [M33_QUEUES.lagProbe]: "platform", // §2.4 — the singleton probe is org-agnostic (pg_stat_replication)
  [M33_QUEUES.tenantEraser]: "platform", // §3.7 — offboarding erase across the org's operational tables
};

// ── the pure processors (thin closures over the §2 workers; the M34 `saas-jobs` processor shape) ───────

/**
 * A pure processor: the body a `Worker(queue, processor, …)` runs. It is `(jobData) => Promise<result>` with
 * the worker's ports already CLOSED OVER by the live wiring (so the run sits inside the right tenancy
 * envelope). Mirrors the M34 `M34JobProcessor` shape — the package worker holds the logic; this is the
 * BullMQ-facing adapter that hands it the typed payload.
 */
export type M33JobProcessor<Data, Result> = (data: Data) => Promise<Result>;

/** `report.mv_refresh` processor — binds the MV-refresh worker over its ports (§2.4 / W-R-06). */
export function mvRefreshProcessor(
  ports: MvRefreshWorkerPorts,
): M33JobProcessor<MvRefreshJob, MvRefreshResult> {
  return (data) => handleMvRefresh(data, ports);
}

/** `report.scheduled_run` processor — binds the scheduled-run worker over its ports (§2.2 / W-R-04). */
export function scheduledRunProcessor(
  ports: ScheduledRunPorts,
): M33JobProcessor<ScheduledRunJob, ScheduledRunResult> {
  return (data) => handleScheduledRun(data, ports);
}

/** The `report.export_render` job: the resolved snapshot + which M22-rendered format to request (§4.8). */
export interface ExportRenderJob extends ExportRenderRequestInput {
  readonly format: ExportRenderFormat;
}

/** The ports the export-render processor composes over (one per M22-rendered format; CSV takes no queue). */
export interface ExportRenderProcessorPorts {
  readonly pdf: PdfRenderRequestPorts;
  readonly xlsx: XlsxRenderRequestPorts;
}

/** `report.export_render` processor — dispatches the §4.8 PDF/XLSX render-request by `format` (the PDF gate
 *  is applied inside `requestPdfRender`; XLSX carries no row cap). */
export function exportRenderProcessor(
  ports: ExportRenderProcessorPorts,
): M33JobProcessor<ExportRenderJob, ExportRenderRequestResult> {
  return ({ format, ...input }) =>
    format === "pdf" ? requestPdfRender(input, ports.pdf) : requestXlsxRender(input, ports.xlsx);
}

/** The direct CSV export is route-streamed (no BullMQ queue, no M22 hop); this thin processor binds the pure
 *  streamer over its ports for the route handler to invoke (the `report.export.csv` W-R-08 path, §4.8). */
export function csvExportProcessor(
  ports: CsvExportPorts,
): M33JobProcessor<CsvExportRequest, CsvExportResult> {
  return (request) => handleCsvExport(request, ports);
}

/** The `report.lag_probe` job carries only the cron tick discriminator (the probe reads its own state). */
export interface LagProbeJob {
  /** The repeatable's tick id (BullMQ supplies one for a `repeat`); the probe ignores the payload. */
  readonly tickId?: string;
}

/** `report.lag_probe` processor — runs one §2.4 probe tick (sample → hysteresis → advisory + emit). */
export function lagProbeProcessor(ports: LagProbePorts): M33JobProcessor<LagProbeJob, LagProbeReport> {
  return () => runLagProbe(ports);
}

/** `report.drilldown_audit_flush` processor — binds the fail-closed envelope-encrypt audit writer (W-R-05). */
export function drilldownAuditFlushProcessor(
  ports: DrilldownAuditPorts,
): M33JobProcessor<DrilldownAuditInput, DrilldownAuditResult> {
  return (data) => writeDrilldownAudit(data, ports);
}

// NOTE — report.tile_warm_cache and report.tenant_eraser are NAMED in the catalog (queue/param/DLQ/idempotency
// truth) but have no processor closure here: tile-warming is a thin upsert the integrator binds against the
// `DashboardTileCacheRepository` at the boot site, and the tenant-offboarding erase (`eraseTenantReporting`) is
// driven through the M4 destruction-registry eraseFn (registerM33Erasers), not a standalone package worker.
// Their `Worker`s land in `m33-jobs.ts` alongside `registerM33Workers` once those deps are assembled — the
// M34 precedent (the sweep workers scheduled but constructed later with their per-run inputs).
