// apps/backend/src/modules/33-reporting/routes/reporting-typebox.ts — M33 (§4.2).
//
// TypeBox request/response schemas for the M33 READ surface (dashboards / tiles / report-base &
// metric catalogs) + the platform/compliance admin surface (MV registry, replica-lag, drilldown
// audit) + the internal MetricsProvider seam endpoint. Named `reporting-typebox` (NOT `*schema*`) so
// the table-ownership import heuristic never mistakes a TypeBox import for a Drizzle one (the M22
// `documents-typebox` / M34 `platform-typebox` precedent). Validation runs through TypeBox `Value` →
// M1's VALIDATION_FAILED envelope (the same `parse(...)` the M22/M34 routes use). Org/actor binding is
// ALWAYS server-side (request.context) — the body/query never carries an org id.
//
// `TileReadQuery` / `TileReadResponse` themselves are the canonical §4.2 shapes owned by the
// @chartwarden/reporting package (packages/reporting/src/schemas/tile-read.ts); we re-export them so the
// route plugins + the OpenAPI enrichment table reference ONE symbol.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { TileReadQuery, TileReadResponse } from "@chartwarden/reporting";
import { ValidationError } from "@chartwarden/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));

// §3.3 vocab mirrors (string-literal unions; canonical enums live in @chartwarden/db).
const BASE_STATUS = ["seeded", "active", "deprecated", "retired"] as const;
const METRIC_STATUS = ["seeded", "active", "deprecated", "retired"] as const;
const MV_STATUS = ["registered", "active", "suspended", "retired"] as const;
const MEASURE_UNIT = ["count", "rate_pct", "currency_cents", "minutes", "days", "ratio"] as const;
const AGGREGATION = ["sum", "avg", "count_distinct", "max", "min", "percentile"] as const;
const DIMENSION_TYPE = ["string", "number", "boolean", "date", "uuid"] as const;

// Re-export the package-owned §4.2 tile shapes so callers import them from the route barrel.
export { TileReadQuery, TileReadResponse };

// ── path params ──────────────────────────────────────────────────────────────────────────────────────
export const TileKeyParamsSchema = Type.Object({
  tileKey: Type.String({ minLength: 1, maxLength: 128 }),
});
export const BaseKeyParamsSchema = Type.Object({
  baseKey: Type.String({ minLength: 1, maxLength: 128 }),
});
export const DashboardIdParamsSchema = Type.Object({
  dashboardId: Type.String({ format: "uuid" }),
});
export const MvKeyParamsSchema = Type.Object({
  mvKey: Type.String({ minLength: 1, maxLength: 128 }),
});
export const MetricKeyParamsSchema = Type.Object({
  metricKey: Type.String({ minLength: 1, maxLength: 128 }),
});

// ── queries (cursor / keyset pagination — §4.1) ───────────────────────────────────────────────────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 256 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

export const DashboardListQuerySchema = Type.Object(PageQuery);
export const BaseListQuerySchema = Type.Object({
  status: Type.Optional(lit(BASE_STATUS)),
  ...PageQuery,
});
export const MetricListQuerySchema = Type.Object({
  status: Type.Optional(lit(METRIC_STATUS)),
  ...PageQuery,
});
export const MvListQuerySchema = Type.Object({
  status: Type.Optional(lit(MV_STATUS)),
  ...PageQuery,
});
export const DrilldownAuditListQuerySchema = Type.Object({
  targetModule: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
  ...PageQuery,
});

// §4.3 — internal MetricsProvider seam endpoint query (single-metric read at an as-of / window).
export const MetricSeamQuerySchema = Type.Object({
  asOf: Type.Optional(Type.String({ format: "date-time" })),
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
});

// ── response views (read surfaces — the Phase-3 reporting screens consume these) ───────────────────────
const CursorPageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
    hasMore: Type.Boolean(),
  });

export const DashboardSummaryViewSchema = Type.Object({
  dashboardId: Type.String(),
  displayName: Type.String(),
  authorship: lit(["system", "tenant"] as const),
  tileCount: Type.Integer(),
  shareScope: lit(["private", "role", "org"] as const),
  isOrgDefault: Type.Boolean(),
});
export const DashboardListResponseSchema = CursorPageOf(DashboardSummaryViewSchema);

/** One tile on a dashboard — the `report_base_catalog.base_key` `GET /reporting/tiles/:tileKey` takes. */
export const DashboardTileDescriptorSchema = Type.Object({
  tileKey: Type.String(),
  displayName: Type.String(),
  kind: Type.String(),
});

/** §4.1 #2 — the dashboard READ: summary + the tile manifest the render screen composes from (F-044). */
export const DashboardDetailViewSchema = Type.Object({
  dashboardId: Type.String(),
  displayName: Type.String(),
  authorship: lit(["system", "tenant"] as const),
  tileCount: Type.Integer(),
  shareScope: lit(["private", "role", "org"] as const),
  isOrgDefault: Type.Boolean(),
  tiles: Type.Array(DashboardTileDescriptorSchema),
});

const DimensionDescriptorSchema = Type.Object({
  dimensionKey: Type.String(),
  displayName: Type.String(),
  dataType: lit(DIMENSION_TYPE),
});
const MeasureDescriptorSchema = Type.Object({
  measureKey: Type.String(),
  displayName: Type.String(),
  metricKey: Type.String(),
  unit: lit(MEASURE_UNIT),
  aggregation: lit(AGGREGATION),
});

export const ReportBaseViewSchema = Type.Object({
  id: Type.String(),
  baseKey: Type.String(),
  displayName: Type.String(),
  domain: Type.String(),
  description: Type.String(),
  mvKey: Type.String(),
  maxRowLimit: Type.Integer(),
  drilldownUrlTemplate: Type.Union([Type.String(), Type.Null()]),
  exposesPhiViaDrilldown: Type.Boolean(),
  status: lit(BASE_STATUS),
  createdAt: Type.String({ format: "date-time" }),
});
export const ReportBaseListResponseSchema = CursorPageOf(ReportBaseViewSchema);

export const ReportBaseDetailViewSchema = Type.Composite([
  ReportBaseViewSchema,
  Type.Object({
    dimensions: Type.Array(DimensionDescriptorSchema),
    measures: Type.Array(MeasureDescriptorSchema),
  }),
]);

export const ReportMetricViewSchema = Type.Object({
  id: Type.String(),
  metricKey: Type.String(),
  displayName: Type.String(),
  unit: lit(MEASURE_UNIT),
  aggregation: lit(AGGREGATION),
  sourceSeam: Type.String(),
  formula: Type.Union([Type.String(), Type.Null()]),
  sensitiveFlag: Type.Boolean(),
  status: lit(METRIC_STATUS),
  createdAt: Type.String({ format: "date-time" }),
});
export const ReportMetricListResponseSchema = CursorPageOf(ReportMetricViewSchema);

export const MvMetadataViewSchema = Type.Object({
  id: Type.String(),
  mvKey: Type.String(),
  schemaName: Type.String(),
  refreshStrategy: lit(["nightly", "incremental", "on_demand"] as const),
  status: lit(MV_STATUS),
  expectedFreshnessSeconds: Type.Integer(),
  debounceWindowSeconds: Type.Integer(),
  lastRefreshedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  lastRefreshDurationMs: Type.Union([Type.Integer(), Type.Null()]),
  refreshFailureCount: Type.Integer(),
});
export const MvMetadataListResponseSchema = CursorPageOf(MvMetadataViewSchema);

export const ReplicaLagViewSchema = Type.Object({
  lagSeconds: Type.Integer(),
  breakerOpen: Type.Boolean(),
  thresholdSeconds: Type.Integer(),
  dataFreshnessSeconds: Type.Integer(),
  sampledAt: Type.String({ format: "date-time" }),
});

export const TileFreshnessViewSchema = Type.Object({
  tileKey: Type.String(),
  dataFreshnessSeconds: Type.Integer(),
  asOf: Type.String({ format: "date-time" }),
  breakerOpen: Type.Boolean(),
});

// `query_filters_cipher` is DENYLISTED (§3.6) and is NEVER projected onto this view.
export const DrilldownAuditViewSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  actorMembershipId: Type.String(),
  reportViewId: Type.Union([Type.String(), Type.Null()]),
  sourceTileKey: Type.String(),
  drilldownTargetModule: Type.Integer(),
  drilldownTargetSurface: Type.String(),
  drilldownTraceId: Type.String(),
  isConsentNarrowed: Type.Boolean(),
  consentNarrowingReason: Type.Union([Type.String(), Type.Null()]),
  accessedAt: Type.String({ format: "date-time" }),
});
export const DrilldownAuditListResponseSchema = CursorPageOf(DrilldownAuditViewSchema);

export const MetricSeamViewSchema = Type.Object({
  metricKey: Type.String(),
  value: Type.Union([Type.Number(), Type.Null()]),
  unit: Type.String(),
  rowCount: Type.Integer(),
  asOf: Type.String({ format: "date-time" }),
  dataFreshnessSeconds: Type.Integer(),
  isForwardSeamDenyStub: Type.Boolean(),
});

export const MvCommandAcceptedSchema = Type.Object({
  mvKey: Type.String(),
  jobId: Type.String(),
});

/** Parse `raw` through `schema` → typed value, or throw M1's VALIDATION_FAILED envelope (M22 `parse`). */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
