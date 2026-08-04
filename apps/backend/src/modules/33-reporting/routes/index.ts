// apps/backend/src/modules/33-reporting/routes/index.ts — M33 READ route barrel.
//
// The dashboards/tiles/catalog READ route plugins (§4.1 #1–#7) + the platform/compliance admin plugin
// (#37–#41) + the internal MetricsProvider seam endpoint (#42), plus their shared route service
// (pure in-memory + Drizzle split), TypeBox schemas, and cursor helpers. `mountM33ReadRoutes` is the
// single composition-root entry (the M34 `mountTenantPlatformRoutes` precedent); the individual plugins
// are exported so route tests can mount one group over a fresh in-memory backend.
import type { FastifyInstance } from "fastify";
import { registerReportingAdminRoutes } from "./admin.routes";
import { registerBaseMetricRoutes } from "./bases-metrics.routes";
import { registerDashboardTileRoutes } from "./dashboards-tiles.routes";
import { registerDefinitionRoutes } from "./definitions.routes";
import { registerDrilldownRoutes } from "./drilldown.routes";
import type { M33ExportDrilldownRouteService } from "./export-drilldown-service";
import { registerExportRoutes } from "./exports.routes";
import { registerMetricsSeamRoutes } from "./metrics-seam.routes";
import type { M33ReadRouteService } from "./read-service";
import { registerScheduleRoutes } from "./schedules.routes";
import { registerViewShareRoutes } from "./views-shares.routes";
import type { M33WriteRouteService } from "./write-service";

export {
  registerDashboardTileRoutes,
  type DashboardTileRouteDeps,
} from "./dashboards-tiles.routes";
export { registerBaseMetricRoutes, type BaseMetricRouteDeps } from "./bases-metrics.routes";
export { registerReportingAdminRoutes, type ReportingAdminRouteDeps } from "./admin.routes";
export { registerMetricsSeamRoutes, type MetricsSeamRouteDeps } from "./metrics-seam.routes";
export { registerDefinitionRoutes, type DefinitionRouteDeps } from "./definitions.routes";
export { registerViewShareRoutes, type ViewShareRouteDeps } from "./views-shares.routes";
export { registerScheduleRoutes, type ScheduleRouteDeps } from "./schedules.routes";
export { registerExportRoutes, type ExportRouteDeps } from "./exports.routes";
export { registerDrilldownRoutes, type DrilldownRouteDeps } from "./drilldown.routes";

export {
  type CsvExportEstimate,
  type CsvSinkPort,
  type DrilldownBulkExportInput,
  type DrilldownEmitInput,
  type DrilldownEmitResult,
  type ExportAcceptedResult,
  type ExportQuery,
  type ExportSqlExecutor,
  type M33ExportDrilldownDrizzleDeps,
  type M33ExportDrilldownRouteService,
  type M33ExportDrilldownSeed,
  ExportRenderUnbound,
  createDrizzleM33ExportDrilldownBackend,
  createInMemoryM33ExportDrilldownBackend,
} from "./export-drilldown-service";

export {
  type CursorPage,
  encodeCursor,
  decodeCursor,
  paginate,
  requireIdempotencyKey,
  IdempotencyKeyRequiredError,
} from "./concurrency";
export { type PreHandler, type M33WriteActor, actorOf, writeActorOf } from "./actor";

export {
  type DashboardSummaryView,
  type DimensionDescriptor,
  type DrilldownAuditView,
  type M33ReadActor,
  type M33ReadBackendInspect,
  type M33ReadEnqueuePort,
  type M33ReadQueueName,
  type M33ReadRouteSeed,
  type M33ReadRouteService,
  type MeasureDescriptor,
  type MetricSeamArgs,
  type MetricSeamView,
  type MvMetadataView,
  type ReplicaLagView,
  type ReportBaseDetailView,
  type ReportBaseView,
  type ReportMetricView,
  type TileFreshnessView,
  type TileReadArgs,
  type TileReadResult,
  createInMemoryM33ReadBackend,
} from "./read-service";

export {
  type M33ReadDrizzleDeps,
  type TileSqlExecutor,
  createDrizzleM33ReadBackend,
} from "./read-service-drizzle";

export {
  type CreateDefinitionArgs,
  type CreateScheduleArgs,
  type CreateViewArgs,
  type CreateVersionArgs,
  type CronPort,
  type DefinitionVersionView,
  type DefinitionView,
  type M33WriteBackendInspect,
  type M33WriteRouteSeed,
  type M33WriteRouteService,
  type RecipientReaderPort,
  type ReportSpec,
  type ScheduleRunView,
  type ScheduleView,
  type ShareView,
  type ShareViewArgs,
  type UpdateScheduleArgs,
  type UpdateViewArgs,
  type ViewView,
  type WriteOutboxPort,
  BaseNotActiveError,
  CronTooFrequentError,
  PdfRowLimitExceededError,
  RecipientNotInOrgError,
  acceptAllRecipientReader,
  createInMemoryM33WriteBackend,
} from "./write-service";

export {
  type M33WriteDrizzleDeps,
  type WriteTx,
  createDrizzleM33WriteBackend,
} from "./write-service-drizzle";

/**
 * Mount the M33 READ + admin + metrics-seam routes over a route service (in-memory slice or the
 * Drizzle-backed service from `createDrizzleM33ReadBackend`). The composition root calls this when a DB
 * client is present, behind the same authenticate/security/error chain (the M34 mount precedent).
 */
export function mountM33ReadRoutes(app: FastifyInstance, service: M33ReadRouteService): void {
  registerDashboardTileRoutes(app, { service });
  registerBaseMetricRoutes(app, { service });
  registerReportingAdminRoutes(app, { service });
  registerMetricsSeamRoutes(app, { service });
}

/**
 * Mount the M33 MUTATING routes (§4.1 #8–#31: definitions / views / shares / schedules) over a write
 * route service (in-memory slice or the Drizzle-backed service from `createDrizzleM33WriteBackend`). The
 * composition root calls this alongside {@link mountM33ReadRoutes} when a DB client is present, behind the
 * same authenticate/security/error chain (the M34 mount precedent). Writes run under `withOrgContext`.
 */
export function mountM33WriteRoutes(app: FastifyInstance, service: M33WriteRouteService): void {
  registerDefinitionRoutes(app, { service });
  registerViewShareRoutes(app, { service });
  registerScheduleRoutes(app, { service });
}

/**
 * Mount the M33 EXPORT + DRILLDOWN routes (§4.1 #32–#36: CSV/PDF/XLSX export + drilldown emit/bulk-export) over
 * an export/drilldown route service (in-memory slice or the Drizzle-backed service from
 * {@link createDrizzleM33ExportDrilldownBackend}). The composition root calls this alongside the read/write
 * mounts when a DB client is present, behind the same authenticate/security/error chain (the M34 precedent).
 * CSV export + bulk drilldown export hijack the response to stream chunked CSV; PDF/XLSX return 202 (M22 handshake).
 */
export function mountM33ExportDrilldownRoutes(
  app: FastifyInstance,
  service: M33ExportDrilldownRouteService,
): void {
  registerExportRoutes(app, { service });
  registerDrilldownRoutes(app, { service });
}
