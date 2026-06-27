// apps/backend/src/modules/33-reporting/routes/read-service-drizzle.ts — M33 the Drizzle-backed
// M33ReadRouteService (§4.1/§4.2 READ + platform/compliance-admin surface).
//
// Implements the SAME {@link M33ReadRouteService} interface as the in-memory slice, but every read opens
// its session through `withReportSession` (the read-REPLICA, RLS-scoped, tiered-statement_timeout read
// path, §8.1.2 / D3) and projects the real Drizzle rows to the identical DTOs. The tile/metric reads call
// the report-builder TRANSLATOR (`translateSpec`) over the platform-shipped base catalog → the
// `report_mv.select_<mvKey>(p_org_id)` SECURITY DEFINER wrapper (D4 — no raw SQL surface); the resulting
// parameterized SELECT is handed to the injected {@link TileSqlExecutor} (P2C binds it over the replica
// session; until then it is a deny-stub → the forward-seam "Not yet available" tile, D6 — never fails open).
// The two MV-admin commands enqueue the on-PRIMARY `report.mv_refresh` worker (§2.4 / §4.8); the read layer
// never refreshes from the request thread.
import { schema } from "@wardenx/db";
import {
  type DashboardCatalogProvider,
  type MetricsProvider,
  REPLICA_LAG_THRESHOLD_SECONDS,
  type ReadReplicaSessionPort,
  ReportCatalogRepository,
  type ReportSessionTier,
  type ReportableScopeEnvelope,
  type ReportingDb,
  type ReplicaLagGatePort,
  type TranslatorBaseCatalog,
  computeFreshnessSeconds,
  translateSpec,
  withReportSession,
} from "@wardenx/reporting";
import { NotFoundError } from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import type { CursorPage } from "./concurrency";
import { paginate } from "./concurrency";
import type {
  DrilldownAuditView,
  M33ReadActor,
  M33ReadEnqueuePort,
  M33ReadRouteService,
  MetricSeamArgs,
  MetricSeamView,
  MvMetadataView,
  ReportBaseDetailView,
  ReportBaseView,
  ReportMetricView,
  ReplicaLagView,
  TileFreshnessView,
  TileReadArgs,
  TileReadResult,
} from "./read-service";

/**
 * Executes a translated, parameterized tile SELECT on the read replica (P2C binds it over the
 * `withReportSession` handle + the result-shaper). Deny-stub-safe: when unbound the Drizzle backend
 * serves the forward-seam empty tile rather than fabricating rows (D6).
 */
export interface TileSqlExecutor {
  execute(input: {
    sql: string;
    params: readonly unknown[];
  }): Promise<{ rows: readonly unknown[]; rowCount: number }>;
}

/** Composition deps the Drizzle read backend binds at boot (P2C). */
export interface M33ReadDrizzleDeps {
  /** The M1 `read_replica_session` port `withReportSession` opens each read under (§8.1.2). */
  readonly replica: ReadReplicaSessionPort;
  /** The D14 replica-lag breaker gate (drives freshness badges + the degrade decision). */
  readonly lag: ReplicaLagGatePort;
  /** The `report.mv_refresh` worker-trigger port the MV-admin commands enqueue to. */
  readonly enqueue: M33ReadEnqueuePort;
  /** The dashboard catalog read surface (#1/#2). Deny-stub (empty) until P2C binds it. */
  readonly dashboards?: DashboardCatalogProvider;
  /** The MetricsProvider seam backing the internal #42 endpoint. Deny-stub (null) until bound. */
  readonly metrics?: MetricsProvider;
  /** Executes a translated tile SELECT on the replica (#3). Deny-stub (forward-seam tile) until bound. */
  readonly tiles?: TileSqlExecutor;
}

const toIso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function mapBaseRow(row: schema.ReportBaseCatalog): ReportBaseView {
  return {
    id: row.id,
    baseKey: row.baseKey,
    displayName: row.displayName,
    domain: row.domain,
    description: row.description,
    mvKey: row.mvKey,
    maxRowLimit: row.maxRowLimit,
    drilldownUrlTemplate: row.drilldownUrlTemplate ?? null,
    exposesPhiViaDrilldown: row.exposesPhiViaDrilldown,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapMetricRow(row: schema.ReportMetricCatalog): ReportMetricView {
  return {
    id: row.id,
    metricKey: row.metricKey,
    displayName: row.displayName,
    unit: row.unit,
    aggregation: row.aggregation,
    sourceSeam: row.sourceSeam,
    formula: row.formula ?? null,
    sensitiveFlag: row.sensitiveFlag,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function mapMvRow(row: schema.MaterializedViewMetadata): MvMetadataView {
  return {
    id: row.id,
    mvKey: row.mvKey,
    schemaName: row.schemaName,
    refreshStrategy: row.refreshStrategy,
    status: row.status,
    expectedFreshnessSeconds: row.expectedFreshnessSeconds,
    debounceWindowSeconds: row.debounceWindowSeconds,
    lastRefreshedAt: toIso(row.lastRefreshedAt),
    lastRefreshDurationMs: row.lastRefreshDurationMs ?? null,
    refreshFailureCount: row.refreshFailureCount,
  };
}

export function createDrizzleM33ReadBackend(deps: M33ReadDrizzleDeps): {
  service: M33ReadRouteService;
} {
  const read = <T>(
    orgId: string,
    tier: ReportSessionTier,
    fn: (db: ReportingDb) => Promise<T>,
  ): Promise<T> =>
    withReportSession<T>({ orgId, tier }, { replica: deps.replica, lag: deps.lag }, fn);

  const sampleLag = async (): Promise<{ lagSeconds: number; breakerOpen: boolean }> => {
    const r = await deps.lag.read();
    return { lagSeconds: r.lagSeconds, breakerOpen: r.breakerOpen };
  };

  const service: M33ReadRouteService = {
    async listDashboards(actor, cursor, limit) {
      const rows = deps.dashboards
        ? await deps.dashboards.listDashboardsForOrg(actor.organizationId)
        : [];
      const withKeys = rows.map((d, i) => ({
        ...d,
        id: d.dashboardId,
        createdAt: `${(rows.length - i).toString().padStart(12, "0")}`,
      }));
      const page = paginate(withKeys, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d) };
    },

    async getDashboard(actor, dashboardId) {
      const rows = deps.dashboards
        ? await deps.dashboards.listDashboardsForOrg(actor.organizationId)
        : [];
      const found = rows.find((d) => d.dashboardId === dashboardId);
      if (!found) throw new NotFoundError("dashboard");
      return found;
    },

    async readTile(actor, tileKey, args) {
      const { lagSeconds } = await sampleLag();
      const scopeKind = args.scopeOverride ?? "org";
      const asOf = args.asOf ?? new Date(Date.now() - lagSeconds * 1000).toISOString();
      const emptyTile = (drilldownUrlTemplate?: string): TileReadResult => ({
        tileKey,
        result: [],
        rowCount: 0,
        dataFreshnessSeconds: computeFreshnessSeconds(lagSeconds),
        asOf,
        drilldownUrlTemplate,
        scopeApplied: { scopeKind, narrowedFromRequested: false },
      });

      return read(actor.organizationId, "tile", async (db) => {
        const catalog = new ReportCatalogRepository(db);
        const base = await catalog.findBaseByKey(tileKey);
        if (!base) throw new NotFoundError("tile");
        const mv = await catalog.findMvByKey(base.mvKey);
        if (!mv || base.measures.length === 0) {
          return emptyTile(base.drilldownUrlTemplate ?? undefined);
        }

        // Build a KPI spec (all measures, no dimensions) + the translator base catalog, then translate
        // to the parameterized SELECT against report_mv.select_<mvKey>(p_org_id) (D4 — no raw SQL).
        const spec: schema.ReportDefinitionSpec = {
          dimensions: [],
          measures: base.measures.slice(0, 16).map((m) => ({ measureKey: m.measureKey })),
          filters: (args.filters as schema.ReportFilter[] | undefined) ?? [],
        };
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
        };
        const scope: ReportableScopeEnvelope = {
          scopeKind,
          organizationId: actor.organizationId,
          membershipIds: [],
          locationIds: [],
        };

        const translation = translateSpec(spec, translatorBase, scope);
        if (translation.kind === "deny_stub" || !deps.tiles) {
          // forward-seam (MV not materialized) OR the executor is not yet bound → "Not yet available".
          return emptyTile(base.drilldownUrlTemplate ?? undefined);
        }
        const { rows, rowCount } = await deps.tiles.execute({
          sql: translation.sql,
          params: translation.params,
        });
        return {
          tileKey,
          result: rows,
          rowCount,
          dataFreshnessSeconds: computeFreshnessSeconds(lagSeconds),
          asOf,
          drilldownUrlTemplate: translation.drilldownUrlTemplate ?? undefined,
          scopeApplied: { scopeKind, narrowedFromRequested: false },
        };
      });
    },

    async getTileFreshness(actor, tileKey) {
      const { lagSeconds, breakerOpen } = await sampleLag();
      await read(actor.organizationId, "tile", async (db) => {
        const base = await new ReportCatalogRepository(db).findBaseByKey(tileKey);
        if (!base) throw new NotFoundError("tile");
        return null;
      });
      return {
        tileKey,
        dataFreshnessSeconds: computeFreshnessSeconds(lagSeconds),
        asOf: new Date(Date.now() - lagSeconds * 1000).toISOString(),
        breakerOpen,
      } satisfies TileFreshnessView;
    },

    async listBases(actor, filter, cursor, limit) {
      const rows = await read(actor.organizationId, "tile", async (db) => {
        const status = filter.status as schema.ReportBaseCatalog["status"] | undefined;
        return new ReportCatalogRepository(db).listBases(status);
      });
      const mapped = rows
        .map(mapBaseRow)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
      return paginate(mapped, cursor, limit) as CursorPage<ReportBaseView>;
    },

    async getBase(actor, baseKey) {
      return read(actor.organizationId, "tile", async (db) => {
        const row = await new ReportCatalogRepository(db).findBaseByKey(baseKey);
        if (!row) throw new NotFoundError("report base");
        const detail: ReportBaseDetailView = {
          ...mapBaseRow(row),
          dimensions: row.dimensions.map((d) => ({
            dimensionKey: d.dimensionKey,
            displayName: d.displayName,
            dataType: d.dataType,
          })),
          measures: row.measures.map((m) => ({
            measureKey: m.measureKey,
            displayName: m.displayName,
            metricKey: m.metricKey,
            unit: m.unit,
            aggregation: m.aggregation,
          })),
        };
        return detail;
      });
    },

    async listMetrics(actor, filter, cursor, limit) {
      const rows = await read(actor.organizationId, "tile", async (db) => {
        const status = filter.status as schema.ReportMetricCatalog["status"] | undefined;
        return new ReportCatalogRepository(db).listMetrics(status);
      });
      const mapped = rows
        .map(mapMetricRow)
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
      return paginate(mapped, cursor, limit) as CursorPage<ReportMetricView>;
    },

    async listMvMetadata(actor, filter, cursor, limit) {
      const rows = await read(actor.organizationId, "tile", async (db) => {
        const status = filter.status as schema.MaterializedViewMetadata["status"] | undefined;
        return new ReportCatalogRepository(db).listMvMetadata(status);
      });
      const withKeys = rows.map((r) => ({ ...mapMvRow(r), createdAt: r.mvKey }));
      const page = paginate(withKeys, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...v }) => v) };
    },

    async refreshMv(actor, mvKey) {
      // verify the MV exists (non-leaking 404) before scheduling the on-primary refresh.
      await read(actor.organizationId, "tile", async (db) => {
        const mv = await new ReportCatalogRepository(db).findMvByKey(mvKey);
        if (!mv) throw new NotFoundError("materialized view");
        return null;
      });
      const { jobId } = await deps.enqueue.enqueue("report.mv_refresh", `${mvKey}:refresh`, {
        mvKey,
        op: "refresh",
        requestedBy: actor.userId,
      });
      return { mvKey, jobId };
    },

    async suspendMv(actor, mvKey) {
      await read(actor.organizationId, "tile", async (db) => {
        const mv = await new ReportCatalogRepository(db).findMvByKey(mvKey);
        if (!mv) throw new NotFoundError("materialized view");
        return null;
      });
      const { jobId } = await deps.enqueue.enqueue("report.mv_refresh", `${mvKey}:suspend`, {
        mvKey,
        op: "suspend",
        requestedBy: actor.userId,
      });
      return { mvKey, jobId };
    },

    async getReplicaLag(_actor): Promise<ReplicaLagView> {
      const { lagSeconds, breakerOpen } = await sampleLag();
      return {
        lagSeconds,
        breakerOpen,
        thresholdSeconds: REPLICA_LAG_THRESHOLD_SECONDS,
        dataFreshnessSeconds: computeFreshnessSeconds(lagSeconds),
        sampledAt: new Date().toISOString(),
      };
    },

    async listDrilldownAudit(actor, filter, cursor, limit) {
      const A = schema.reportDrilldownAudit;
      const rows = await read(actor.organizationId, "tile", async (db) => {
        const where =
          filter.targetModule !== undefined
            ? and(
                eq(A.organizationId, actor.organizationId),
                eq(A.drilldownTargetModule, filter.targetModule),
              )
            : eq(A.organizationId, actor.organizationId);
        return db.select().from(A).where(where).orderBy(desc(A.accessedAt)).limit(500);
      });
      // `query_filters_cipher` is DENYLISTED (§3.6) — never projected onto the view.
      const mapped: (DrilldownAuditView & { createdAt: string })[] = rows.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        actorMembershipId: r.actorMembershipId,
        reportViewId: r.reportViewId ?? null,
        sourceTileKey: r.sourceTileKey,
        drilldownTargetModule: r.drilldownTargetModule,
        drilldownTargetSurface: r.drilldownTargetSurface,
        drilldownTraceId: r.drilldownTraceId,
        isConsentNarrowed: r.isConsentNarrowed,
        consentNarrowingReason: r.consentNarrowingReason ?? null,
        accessedAt: r.accessedAt.toISOString(),
        createdAt: r.accessedAt.toISOString(),
      }));
      const page = paginate(mapped, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...d }) => d) };
    },

    async getDashboardMetricSeam(actor, metricKey, args: MetricSeamArgs): Promise<MetricSeamView> {
      if (!deps.metrics) {
        const { lagSeconds } = await sampleLag();
        return {
          metricKey,
          value: null,
          unit: "count",
          rowCount: 0,
          asOf: args.asOf ?? new Date(Date.now() - lagSeconds * 1000).toISOString(),
          dataFreshnessSeconds: computeFreshnessSeconds(lagSeconds),
          isForwardSeamDenyStub: true,
        };
      }
      const r = await deps.metrics.getDashboardMetric({
        metricKey,
        organizationId: actor.organizationId,
        asOf: args.asOf,
        period: args.period,
      });
      return {
        metricKey: r.metricKey,
        value: r.value,
        unit: r.unit,
        rowCount: r.rowCount,
        asOf: r.asOf,
        dataFreshnessSeconds: r.dataFreshnessSeconds,
        isForwardSeamDenyStub: r.isForwardSeamDenyStub,
      };
    },
  };

  return { service };
}
