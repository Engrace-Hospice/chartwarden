// apps/backend/src/modules/33-reporting/routes/read-service-drizzle.ts — M33 the Drizzle-backed
// M33ReadRouteService (§4.1/§4.2 READ + platform/compliance-admin surface).
//
// Implements the SAME {@link M33ReadRouteService} interface as the in-memory slice, but every read opens
// its session through `withReportSession` (the read-REPLICA, RLS-scoped, tiered-statement_timeout read
// path, §8.1.2 / D3) and projects the real Drizzle rows to the identical DTOs. The tile/metric reads call
// the report-builder TRANSLATOR (`translateSpec`) over the platform-shipped base catalog → the
// `report_mv.select_<mvKey>(p_org_id)` SECURITY DEFINER wrapper (D4 — no raw SQL surface); the resulting
// parameterized SELECT is handed to the injected {@link TileSqlExecutor}, which runs it on that same
// session. A base whose MV is still `registered` (the upstream producer has not landed) forward-seams to
// the empty "Not yet available" tile — that gate is inside `translateSpec`, not the executor (D6).
//
// F-044: the executor comment used to read "P2C binds it over the replica session; until then it is a
// deny-stub". It was bound on 2026-08-13 (GAP-051) and the sentence was not updated, so a doc outlived the
// code it described and was later read as a live finding. What was ACTUALLY unbound sat one layer above it
// and is what a user meets first: `dashboards` (so `GET /reporting/dashboards` was `[]` for every org
// forever, and `getDashboard` could resolve none — the working tile route was unreachable, because both
// screens that lead to it get their tile list from `getDashboard`), the dashboard TILE MANIFEST (carried by
// no DTO at all), and `metrics` (so route #42 and the M30/M34/M37 embeds answered `value: null,
// isForwardSeamDenyStub: true` for every metric, forever). All three bind here now.
// The two MV-admin commands enqueue the on-PRIMARY `report.mv_refresh` worker (§2.4 / §4.8); the read layer
// never refreshes from the request thread.
import { schema } from "@wardenx/db";
import {
  type DashboardCatalogProvider,
  type MetricsProvider,
  REPLICA_LAG_THRESHOLD_SECONDS,
  type ReadReplicaSessionPort,
  type ReplicaLagGatePort,
  ReportCatalogRepository,
  ReportDefinitionRepository,
  type ReportSessionTier,
  ReportViewRepository,
  type ReportableScopeEnvelope,
  type ReportingDb,
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
  DashboardDetailView,
  DrilldownAuditView,
  M33ReadActor,
  M33ReadEnqueuePort,
  M33ReadRouteService,
  MetricSeamArgs,
  MetricSeamView,
  MvMetadataView,
  ReplicaLagView,
  ReportBaseDetailView,
  ReportBaseView,
  ReportMetricView,
  TileFreshnessView,
  TileReadArgs,
  TileReadResult,
} from "./read-service";

/**
 * Executes a translated, parameterized tile SELECT on the read replica (P2C binds it over the
 * `withReportSession` handle + the result-shaper). Deny-stub-safe: when unbound the Drizzle backend
 * serves the forward-seam empty tile rather than fabricating rows (D6).
 *
 * Takes the ACTIVE `ReportingDb` handle as its first argument rather than capturing one at construction:
 * the executor is built ONCE at wiring time, but every call must run on the SAME per-request
 * `withReportSession` transaction the caller already opened (that tx carries the `SET LOCAL app.org_id` /
 * `default_transaction_read_only` / `statement_timeout` GUCs, §8.1.2) — a statically-captured connection
 * would run outside that scope and FORCE RLS would silently return zero rows instead of the real tile.
 */
export interface TileSqlExecutor {
  execute(
    db: ReportingDb,
    input: { sql: string; params: readonly unknown[] },
  ): Promise<{ rows: readonly unknown[]; rowCount: number }>;
}

/** Composition deps the Drizzle read backend binds at boot (P2C). */
export interface M33ReadDrizzleDeps {
  /** The M1 `read_replica_session` port `withReportSession` opens each read under (§8.1.2). */
  readonly replica: ReadReplicaSessionPort;
  /** The D14 replica-lag breaker gate (drives freshness badges + the degrade decision). */
  readonly lag: ReplicaLagGatePort;
  /** The `report.mv_refresh` worker-trigger port the MV-admin commands enqueue to. */
  readonly enqueue: M33ReadEnqueuePort;
  /** The dashboard catalog read surface (#1/#2) — the org's shared saved views. */
  readonly dashboards: DashboardCatalogProvider;
  /** The MetricsProvider seam backing the internal #42 endpoint (§4.3). */
  readonly metrics: MetricsProvider;
  /** Executes a translated tile SELECT on the replica (#3). Deny-stub (forward-seam tile) until bound. */
  readonly tiles?: TileSqlExecutor;
  /**
   * Resolves the caller's §4.7.1 `reportable_scope` envelope (D8). REQUIRED, and deliberately not
   * optional-with-an-`org`-default: the whole of F-059 is that every read path here quietly defaulted to
   * `org` and the resolved envelope was thrown away, so a `self`-scoped clinician read the entire
   * organization's per-clinician productivity. A dep that cannot be omitted cannot be forgotten again.
   */
  readonly scope: ReportScopeResolverPort;
}

/**
 * Resolves the actor into the SEALED §4.7.1 scope envelope the SQL translator narrows on (D8).
 *
 * `resolveReportableScope` (abac-predicates.ts) has computed exactly this on every request since M33
 * landed — inside the `reportable_scope` predicate, which then discarded it and returned a boolean. Its
 * own doc comment says "the route layer reads the resolved envelope to inject the WHERE clause"; no route
 * ever did, and `resolveReportableScope` had no caller outside the predicate that ignores its result.
 */
export interface ReportScopeResolverPort {
  resolve(actor: {
    readonly organizationId: string;
    readonly userId: string;
    readonly membershipId?: string;
    readonly roles: readonly string[];
  }): Promise<ReportableScopeEnvelope>;
}

const toIso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Apply the request's optional `scopeOverride` to the RESOLVED envelope, and report whether the server
 * had to narrow the request. The resolved scope is the CEILING: an override may narrow, never widen.
 *
 * `scopeOverride` is a query parameter — caller-supplied — and before F-059 it WAS the scope, with `org`
 * as its default, so the widest reading was both the fallback and freely requestable. Only `self` is
 * honoured as a narrowing, because it is the one kind whose id set the server can derive without the
 * resolver (the actor's own membership); `team`/`location` name id sets that only `resolveReportableScope`
 * can produce, and taking those off a query string is the bug this replaces.
 *
 * A widening request is CLAMPED to the resolved scope rather than refused, and the clamp is reported in
 * the response as `scopeApplied.narrowedFromRequested` — which is what that field was for, and why it was
 * suspicious that it was hard-coded `false`: with the scope itself read off the request, nothing could
 * ever narrow it, so the field could only ever have said `false`. The caller gets data it is entitled to
 * plus an explicit statement that this is not the whole organization, which is strictly more useful than
 * a 403 and cannot be mistaken for the wide answer.
 */
export function narrowScope(
  resolved: ReportableScopeEnvelope,
  override: "self" | "team" | "location" | "org" | undefined,
  ownMembershipId: string | undefined,
): { scope: ReportableScopeEnvelope; narrowedFromRequested: boolean } {
  if (override === undefined || override === resolved.scopeKind) {
    return { scope: resolved, narrowedFromRequested: false };
  }
  if (override === "self") {
    return {
      scope: {
        scopeKind: "self",
        organizationId: resolved.organizationId,
        membershipIds: ownMembershipId ? [ownMembershipId] : [],
        locationIds: [],
      },
      narrowedFromRequested: false,
    };
  }
  return { scope: resolved, narrowedFromRequested: true };
}

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
      const rows = await deps.dashboards.listDashboardsForOrg(actor.organizationId);
      const withKeys = rows.map((d, i) => ({
        ...d,
        id: d.dashboardId,
        createdAt: `${(rows.length - i).toString().padStart(12, "0")}`,
      }));
      const page = paginate(withKeys, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d) };
    },

    async getDashboard(actor, dashboardId) {
      // The TILE MANIFEST (F-044). `dashboard-render.tsx` has always read `detail.tiles` and typed it
      // optional, with the comment "Production projects the tile manifest" — nothing did, in any backend,
      // so every resolved dashboard rendered the "the tile manifest is not available in this context"
      // empty state and the working tile route was reachable only by typing a tileKey into the URL.
      //
      // A dashboard IS a saved view (`report_view`) bound to one immutable definition version, and a
      // definition is bound to exactly one `base_key` (§3.3) — and `readTile`'s key IS the base key
      // (`findBaseByKey(tileKey)`). So the manifest is not new state to invent: it is that binding,
      // followed and named.
      return read(actor.organizationId, "tile", async (db) => {
        const view = await new ReportViewRepository(db).findById(dashboardId);
        if (!view || view.organizationId !== actor.organizationId)
          throw new NotFoundError("dashboard");
        const defRepo = new ReportDefinitionRepository(db);
        const version = await defRepo.findVersionById(view.definitionVersionId);
        const definition = version ? await defRepo.findDefinitionById(version.definitionId) : null;
        const base = definition
          ? await new ReportCatalogRepository(db).findBaseByKey(definition.baseKey)
          : null;
        // The tile is named for the BASE, not the definition. A dashboard with one tile otherwise renders
        // the tenant's own label twice — as the page's `<h1>` and again as the tile's `<h2>` — and the
        // second one is the place to say what the data actually is ("Encounter Productivity by Clinician")
        // rather than to repeat what they called it.
        const tiles = base
          ? [{ tileKey: base.baseKey, displayName: base.displayName, kind: base.domain }]
          : [];
        return {
          dashboardId: view.id,
          displayName: view.displayName,
          authorship: definition?.authorship ?? "tenant",
          tileCount: tiles.length,
          shareScope: view.shareScope,
          isOrgDefault: view.isOrgDefault,
          tiles,
        } satisfies DashboardDetailView;
      });
    },

    async readTile(actor, tileKey, args) {
      const { lagSeconds } = await sampleLag();
      const { scope, narrowedFromRequested } = narrowScope(
        await deps.scope.resolve(actor),
        args.scopeOverride,
        actor.membershipId,
      );
      const scopeKind = scope.scopeKind;
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
          scopeMembershipColumn: base.scopeMembershipColumn,
          scopeLocationColumn: base.scopeLocationColumn,
        };
        const translation = translateSpec(spec, translatorBase, scope);
        if (translation.kind === "deny_stub" || !deps.tiles) {
          // forward-seam (MV not materialized) OR the executor is not yet bound → "Not yet available".
          return emptyTile(base.drilldownUrlTemplate ?? undefined);
        }
        const { rows, rowCount } = await deps.tiles.execute(db, {
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
          scopeApplied: { scopeKind, narrowedFromRequested },
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
        .sort((a, b) =>
          a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
        );
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
        .sort((a, b) =>
          a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
        );
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
