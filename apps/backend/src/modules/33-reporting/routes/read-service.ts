// apps/backend/src/modules/33-reporting/routes/read-service.ts — M33 the M33ReadRouteService + an
// in-memory slice (§4.1/§4.2 READ + platform/compliance-admin surface).
//
// The dashboards/tiles/catalog READ routes + the platform MV-admin / replica-lag / drilldown-audit
// routes + the internal MetricsProvider seam endpoint all compose over this service. Mirrors the M22
// routes/service.ts + M34 routes/platform/service.ts precedent EXACTLY:
//   - READ/LIST methods are fully live: in the slice they read the deterministic in-memory dataset;
//     PRODUCTION injects the Drizzle-backed service (read-service-drizzle.ts) whose reads run under
//     `withReportSession` (the read-REPLICA, RLS-scoped, tiered-statement_timeout read path, §8.1.2 / D3).
//     A missing row is a non-leaking 404.
//   - The two MUTATING admin commands (mv refresh / mv suspend) ENQUEUE the matching `report.mv_refresh`
//     worker job through the injected {@link M33ReadEnqueuePort} and return the job id (HTTP 202) — the
//     refresh runs on the PRIMARY in the worker, never the request thread (§2.4 / §4.8).
import { NotFoundError } from "@wardenx/types";
import { type CursorPage, paginate } from "./concurrency";

// ── actor (server-assembled; org/actor binding is the context, never the body/query) ─────────────────
export interface M33ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /**
   * The session's active membership id (`context.attributes.membershipId`), when it carries one. Used
   * ONLY to resolve the §4.7.1 `self` scope — a read actor with no membership resolves to `self` over an
   * EMPTY id set, which the scope injector compiles to `FALSE` (deny), never to org-wide (D8).
   */
  readonly membershipId?: string;
}

// ── enqueue port (the thin worker-trigger seam the admin command routes inject) ──────────────────────
/** The §4.8 BullMQ queue the M33 MV-admin command routes enqueue to. */
export type M33ReadQueueName = "report.mv_refresh";

/**
 * The thin worker-trigger port the MV-admin command routes call. In the slice it records the enqueue (so
 * route tests assert the job was scheduled); PRODUCTION binds it to the @wardenx/shared transactional
 * outbox / BullMQ producer for the `report.mv_refresh` queue (the on-PRIMARY refresh worker). Keeping it
 * injected keeps the route layer free of any BullMQ/Valkey import.
 */
export interface M33ReadEnqueuePort {
  enqueue(
    queue: M33ReadQueueName,
    jobKey: string,
    payload: Record<string, unknown>,
  ): Promise<{ jobId: string }>;
}

// ── route DTOs (in-memory; the Drizzle adapter projects rows to the SAME shapes) ─────────────────────

/** A dashboard available in an org's scope (= the DashboardCatalogProvider element; §4.3). */
export interface DashboardSummaryView {
  readonly dashboardId: string;
  readonly displayName: string;
  readonly authorship: "system" | "tenant";
  readonly tileCount: number;
  readonly shareScope: "private" | "role" | "org";
  readonly isOrgDefault: boolean;
}

/** One tile on a dashboard: the `report_base_catalog` key `readTile` resolves, plus its label (§4.1 #2). */
export interface DashboardTileDescriptor {
  /** The `GET /reporting/tiles/:tileKey` key — a `report_base_catalog.base_key`. */
  readonly tileKey: string;
  readonly displayName: string;
  /** The base's domain (`census` / `productivity` / `evv` / …), for tile grouping in the UI. */
  readonly kind: string;
}

/**
 * A dashboard READ (§4.1 #2 — "read a dashboard (composed of multiple tiles)"): the summary plus the
 * TILE MANIFEST. F-044 — the manifest existed in no DTO, so the render screen's `tiles` was permanently
 * undefined and every dashboard showed "the tile manifest is not available in this context".
 */
export interface DashboardDetailView extends DashboardSummaryView {
  readonly tiles: readonly DashboardTileDescriptor[];
}

export interface DimensionDescriptor {
  readonly dimensionKey: string;
  readonly displayName: string;
  readonly dataType: "string" | "number" | "boolean" | "date" | "uuid";
}
export interface MeasureDescriptor {
  readonly measureKey: string;
  readonly displayName: string;
  readonly metricKey: string;
  readonly unit: "count" | "rate_pct" | "currency_cents" | "minutes" | "days" | "ratio";
  readonly aggregation: "sum" | "avg" | "count_distinct" | "max" | "min" | "percentile";
}

/** A report base (the report-builder base picker; §3.3). */
export interface ReportBaseView {
  readonly id: string;
  readonly baseKey: string;
  readonly displayName: string;
  readonly domain: string;
  readonly description: string;
  readonly mvKey: string;
  readonly maxRowLimit: number;
  readonly drilldownUrlTemplate: string | null;
  readonly exposesPhiViaDrilldown: boolean;
  readonly status: "seeded" | "active" | "deprecated" | "retired";
  readonly createdAt: string;
}
export interface ReportBaseDetailView extends ReportBaseView {
  readonly dimensions: readonly DimensionDescriptor[];
  readonly measures: readonly MeasureDescriptor[];
}

/** A metric in the platform metric catalog (§3.3). */
export interface ReportMetricView {
  readonly id: string;
  readonly metricKey: string;
  readonly displayName: string;
  readonly unit: "count" | "rate_pct" | "currency_cents" | "minutes" | "days" | "ratio";
  readonly aggregation: "sum" | "avg" | "count_distinct" | "max" | "min" | "percentile";
  readonly sourceSeam: string;
  readonly formula: string | null;
  readonly sensitiveFlag: boolean;
  readonly status: "seeded" | "active" | "deprecated" | "retired";
  readonly createdAt: string;
}

/** The §3.3 materialized-view registry row (platform MV-admin surface, §4.6). */
export interface MvMetadataView {
  readonly id: string;
  readonly mvKey: string;
  readonly schemaName: string;
  readonly refreshStrategy: "nightly" | "incremental" | "on_demand";
  readonly status: "registered" | "active" | "suspended" | "retired";
  readonly expectedFreshnessSeconds: number;
  readonly debounceWindowSeconds: number;
  readonly lastRefreshedAt: string | null;
  readonly lastRefreshDurationMs: number | null;
  readonly refreshFailureCount: number;
}

/** The D14 replica-lag posture the platform admin surface reads (§4.8). */
export interface ReplicaLagView {
  readonly lagSeconds: number;
  readonly breakerOpen: boolean;
  readonly thresholdSeconds: number;
  readonly dataFreshnessSeconds: number;
  readonly sampledAt: string;
}

/** The freshness badge a tile renders (§2.4 — `data_freshness_seconds` + the "Data as of" timestamp). */
export interface TileFreshnessView {
  readonly tileKey: string;
  readonly dataFreshnessSeconds: number;
  readonly asOf: string;
  readonly breakerOpen: boolean;
}

/** A drilldown-audit row (§3.3 — `query_filters_cipher` is DENYLISTED and NEVER projected here). */
export interface DrilldownAuditView {
  readonly id: string;
  readonly organizationId: string;
  readonly actorMembershipId: string;
  readonly reportViewId: string | null;
  readonly sourceTileKey: string;
  readonly drilldownTargetModule: number;
  readonly drilldownTargetSurface: string;
  readonly drilldownTraceId: string;
  readonly isConsentNarrowed: boolean;
  readonly consentNarrowingReason: string | null;
  readonly accessedAt: string;
}

/** The internal MetricsProvider seam read shape (#42 — backs M30/M34/M37 embeds; §4.3). */
export interface MetricSeamView {
  readonly metricKey: string;
  readonly value: number | null;
  readonly unit: string;
  readonly rowCount: number;
  readonly asOf: string;
  readonly dataFreshnessSeconds: number;
  readonly isForwardSeamDenyStub: boolean;
}

/** The aggregate-only tile result (= the package-owned §4.2 `TileReadResponse`). */
export interface TileReadResult {
  readonly tileKey: string;
  readonly result: readonly unknown[];
  readonly rowCount: number;
  readonly dataFreshnessSeconds: number;
  readonly asOf: string;
  readonly drilldownUrlTemplate?: string;
  readonly scopeApplied: {
    readonly scopeKind: "self" | "team" | "location" | "org";
    readonly narrowedFromRequested: boolean;
  };
}

/** The §4.2 tile-read request (filters + requested scope override + as-of). */
export interface TileReadArgs {
  readonly filters?: readonly unknown[];
  readonly scopeOverride?: "self" | "team" | "location" | "org";
  readonly asOf?: string;
}

/** The internal MetricsProvider seam request (#42). */
export interface MetricSeamArgs {
  readonly asOf?: string;
  readonly period?: { from: string; to: string };
}

// ── the route service the handlers compose over ─────────────────────────────────────────────────────
export interface M33ReadRouteService {
  // dashboards (§4.1 #1–#2)
  listDashboards(
    actor: M33ReadActor,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<DashboardSummaryView>>;
  getDashboard(actor: M33ReadActor, dashboardId: string): Promise<DashboardDetailView>;
  // tiles (§4.1 #3–#4)
  readTile(actor: M33ReadActor, tileKey: string, args: TileReadArgs): Promise<TileReadResult>;
  getTileFreshness(actor: M33ReadActor, tileKey: string): Promise<TileFreshnessView>;
  // catalog reads (§4.1 #5–#7)
  listBases(
    actor: M33ReadActor,
    filter: { status?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ReportBaseView>>;
  getBase(actor: M33ReadActor, baseKey: string): Promise<ReportBaseDetailView>;
  listMetrics(
    actor: M33ReadActor,
    filter: { status?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ReportMetricView>>;
  // platform / compliance admin (§4.1 #37–#41)
  listMvMetadata(
    actor: M33ReadActor,
    filter: { status?: string },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<MvMetadataView>>;
  refreshMv(actor: M33ReadActor, mvKey: string): Promise<{ mvKey: string; jobId: string }>;
  suspendMv(actor: M33ReadActor, mvKey: string): Promise<{ mvKey: string; jobId: string }>;
  getReplicaLag(actor: M33ReadActor): Promise<ReplicaLagView>;
  listDrilldownAudit(
    actor: M33ReadActor,
    filter: { targetModule?: number },
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<DrilldownAuditView>>;
  // internal MetricsProvider seam (#42)
  getDashboardMetricSeam(
    actor: M33ReadActor,
    metricKey: string,
    args: MetricSeamArgs,
  ): Promise<MetricSeamView>;
}

// ── in-memory records + slice ─────────────────────────────────────────────────────────────────────────

/** Deterministic, I/O-free seed for the in-memory read service (slice + smoke tests). */
export interface M33ReadRouteSeed {
  readonly dashboards?: readonly DashboardSummaryView[];
  readonly bases?: readonly (Partial<ReportBaseDetailView> & { baseKey: string })[];
  readonly metrics?: readonly (Partial<ReportMetricView> & { metricKey: string })[];
  readonly mvs?: readonly (Partial<MvMetadataView> & { mvKey: string })[];
  readonly drilldownAudit?: readonly (Partial<DrilldownAuditView> & { id: string })[];
  readonly lag?: { lagSeconds: number; breakerOpen: boolean; thresholdSeconds?: number };
  readonly metricValues?: Readonly<Record<string, { value: number | null; unit: string }>>;
}

/** Pads `n` to a uuid-shaped id so created ids round-trip through uuid-validated bodies (M22 slice). */
function uuidFromCounter(prefixNibble: string, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefixNibble}0000000-0000-4000-8000-${hex}`;
}

/** Read-only inspection surface over the slice (the route tests assert against it). */
export interface M33ReadBackendInspect {
  baseCount(): number;
  enqueuedJobs(): ReadonlyArray<{ queue: M33ReadQueueName; jobKey: string }>;
}

export function createInMemoryM33ReadBackend(seed: M33ReadRouteSeed = {}): {
  service: M33ReadRouteService;
  enqueue: M33ReadEnqueuePort;
  inspect: M33ReadBackendInspect;
} {
  const now = () => "2026-06-21T12:00:00.000Z";
  let sub = 0;
  const subId = () => uuidFromCounter("a", ++sub);

  const dashboards: DashboardSummaryView[] = [...(seed.dashboards ?? [])];
  const bases = new Map<string, ReportBaseDetailView>();
  const metrics = new Map<string, ReportMetricView>();
  const mvs = new Map<string, MvMetadataView>();
  const drilldown: DrilldownAuditView[] = [];
  const enqueued: Array<{ queue: M33ReadQueueName; jobKey: string }> = [];
  const lag = {
    lagSeconds: seed.lag?.lagSeconds ?? 12,
    breakerOpen: seed.lag?.breakerOpen ?? false,
    thresholdSeconds: seed.lag?.thresholdSeconds ?? 600,
  };
  const metricValues = seed.metricValues ?? {};

  for (const b of seed.bases ?? []) {
    bases.set(b.baseKey, {
      id: b.id ?? subId(),
      baseKey: b.baseKey,
      displayName: b.displayName ?? b.baseKey,
      domain: b.domain ?? "census",
      description: b.description ?? "",
      mvKey: b.mvKey ?? `mv_${b.baseKey}`,
      maxRowLimit: b.maxRowLimit ?? 10000,
      drilldownUrlTemplate: b.drilldownUrlTemplate ?? null,
      exposesPhiViaDrilldown: b.exposesPhiViaDrilldown ?? false,
      status: b.status ?? "active",
      createdAt: b.createdAt ?? now(),
      dimensions: b.dimensions ?? [],
      measures: b.measures ?? [],
    });
  }
  for (const m of seed.metrics ?? []) {
    metrics.set(m.metricKey, {
      id: m.id ?? subId(),
      metricKey: m.metricKey,
      displayName: m.displayName ?? m.metricKey,
      unit: m.unit ?? "count",
      aggregation: m.aggregation ?? "sum",
      sourceSeam: m.sourceSeam ?? "",
      formula: m.formula ?? null,
      sensitiveFlag: m.sensitiveFlag ?? false,
      status: m.status ?? "active",
      createdAt: m.createdAt ?? now(),
    });
  }
  for (const v of seed.mvs ?? []) {
    mvs.set(v.mvKey, {
      id: v.id ?? subId(),
      mvKey: v.mvKey,
      schemaName: v.schemaName ?? "report_mv",
      refreshStrategy: v.refreshStrategy ?? "nightly",
      status: v.status ?? "active",
      expectedFreshnessSeconds: v.expectedFreshnessSeconds ?? 86400,
      debounceWindowSeconds: v.debounceWindowSeconds ?? 5,
      lastRefreshedAt: v.lastRefreshedAt ?? null,
      lastRefreshDurationMs: v.lastRefreshDurationMs ?? null,
      refreshFailureCount: v.refreshFailureCount ?? 0,
    });
  }
  for (const d of seed.drilldownAudit ?? []) {
    drilldown.push({
      id: d.id,
      organizationId: d.organizationId ?? uuidFromCounter("e", 1),
      actorMembershipId: d.actorMembershipId ?? subId(),
      reportViewId: d.reportViewId ?? null,
      sourceTileKey: d.sourceTileKey ?? "tile",
      drilldownTargetModule: d.drilldownTargetModule ?? 8,
      drilldownTargetSurface: d.drilldownTargetSurface ?? "register",
      drilldownTraceId: d.drilldownTraceId ?? subId(),
      isConsentNarrowed: d.isConsentNarrowed ?? false,
      consentNarrowingReason: d.consentNarrowingReason ?? null,
      accessedAt: d.accessedAt ?? now(),
    });
  }

  /** DESC by `(createdAt, id)` for keyset pagination. */
  const desc = <T extends { createdAt: string; id: string }>(rows: T[]): T[] =>
    [...rows].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    );

  const enqueuePort: M33ReadEnqueuePort = {
    async enqueue(queue, jobKey, _payload) {
      enqueued.push({ queue, jobKey });
      return { jobId: subId() };
    },
  };

  const freshnessAsOf = () => new Date(Date.parse(now()) - lag.lagSeconds * 1000).toISOString();

  const service: M33ReadRouteService = {
    async listDashboards(_actor, cursor, limit) {
      const rows = dashboards.map((d, i) => ({
        ...d,
        id: d.dashboardId,
        createdAt: uuidFromCounter("d", dashboards.length - i),
      }));
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, id: _i, ...d }) => d) };
    },
    async getDashboard(_actor, dashboardId) {
      const found = dashboards.find((d) => d.dashboardId === dashboardId);
      if (!found) throw new NotFoundError("dashboard");
      // Slice parity with the Drizzle backend's manifest (F-044). The seed carries summaries only, so the
      // slice synthesizes one tile per declared tile count rather than reporting `tiles: []` — a shape the
      // Drizzle backend can only produce for a dashboard whose definition resolves to no base at all.
      const tiles = Array.from({ length: found.tileCount }, (_v, i) => ({
        tileKey: `${found.dashboardId}-tile-${i + 1}`,
        displayName: found.displayName,
        kind: "slice",
      }));
      return { ...found, tiles };
    },
    async readTile(_actor, tileKey, args) {
      const base = bases.get(tileKey);
      if (!base) throw new NotFoundError("tile");
      const scopeKind = args.scopeOverride ?? "org";
      const denyStub = base.status !== "active";
      return {
        tileKey,
        result: [],
        rowCount: 0,
        dataFreshnessSeconds: lag.lagSeconds,
        asOf: args.asOf ?? freshnessAsOf(),
        drilldownUrlTemplate: base.drilldownUrlTemplate ?? undefined,
        scopeApplied: { scopeKind, narrowedFromRequested: false },
        // a non-active base renders the forward-seam "Not yet available" tile (deny-stub, D6).
        ...(denyStub ? { result: [], rowCount: 0 } : {}),
      };
    },
    async getTileFreshness(_actor, tileKey) {
      if (!bases.has(tileKey)) throw new NotFoundError("tile");
      return {
        tileKey,
        dataFreshnessSeconds: lag.lagSeconds,
        asOf: freshnessAsOf(),
        breakerOpen: lag.breakerOpen,
      };
    },
    async listBases(_actor, filter, cursor, limit) {
      const rows = desc(
        [...bases.values()]
          .filter((b) => (filter.status ? b.status === filter.status : true))
          .map(({ dimensions: _d, measures: _m, ...b }) => b),
      );
      return paginate(rows, cursor, limit);
    },
    async getBase(_actor, baseKey) {
      const b = bases.get(baseKey);
      if (!b) throw new NotFoundError("report base");
      return b;
    },
    async listMetrics(_actor, filter, cursor, limit) {
      const rows = desc(
        [...metrics.values()].filter((m) => (filter.status ? m.status === filter.status : true)),
      );
      return paginate(rows, cursor, limit);
    },
    async listMvMetadata(_actor, filter, cursor, limit) {
      const rows = desc(
        [...mvs.values()]
          .filter((v) => (filter.status ? v.status === filter.status : true))
          .map((v) => ({ ...v, createdAt: v.mvKey })),
      );
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...v }) => v) };
    },
    async refreshMv(_actor, mvKey) {
      if (!mvs.has(mvKey)) throw new NotFoundError("materialized view");
      const { jobId } = await enqueuePort.enqueue("report.mv_refresh", `${mvKey}:refresh`, {
        mvKey,
        op: "refresh",
      });
      return { mvKey, jobId };
    },
    async suspendMv(_actor, mvKey) {
      const v = mvs.get(mvKey);
      if (!v) throw new NotFoundError("materialized view");
      mvs.set(mvKey, { ...v, status: "suspended" });
      const { jobId } = await enqueuePort.enqueue("report.mv_refresh", `${mvKey}:suspend`, {
        mvKey,
        op: "suspend",
      });
      return { mvKey, jobId };
    },
    async getReplicaLag(_actor) {
      return {
        lagSeconds: lag.lagSeconds,
        breakerOpen: lag.breakerOpen,
        thresholdSeconds: lag.thresholdSeconds,
        dataFreshnessSeconds: Math.max(0, lag.lagSeconds),
        sampledAt: now(),
      };
    },
    async listDrilldownAudit(actor, filter, cursor, limit) {
      const rows = desc(
        drilldown
          .filter((d) => d.organizationId === actor.organizationId || true)
          .filter((d) =>
            filter.targetModule ? d.drilldownTargetModule === filter.targetModule : true,
          )
          .map((d) => ({ ...d, createdAt: d.accessedAt })),
      );
      const page = paginate(rows, cursor, limit);
      return { ...page, items: page.items.map(({ createdAt: _c, ...d }) => d) };
    },
    async getDashboardMetricSeam(_actor, metricKey, args) {
      const hit = metricValues[metricKey];
      return {
        metricKey,
        value: hit?.value ?? null,
        unit: hit?.unit ?? "count",
        rowCount: hit ? 1 : 0,
        asOf: args.asOf ?? freshnessAsOf(),
        dataFreshnessSeconds: lag.lagSeconds,
        isForwardSeamDenyStub: hit === undefined,
      };
    },
  };

  const inspect: M33ReadBackendInspect = {
    baseCount: () => bases.size,
    enqueuedJobs: () => enqueued,
  };

  return { service, enqueue: enqueuePort, inspect };
}
