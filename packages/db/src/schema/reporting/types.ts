// @chartwarden/db — M33 Reporting: shared TypeScript shapes for the jsonb columns in the reporting
// schema (§3.3). These are the row-stored projections of the catalog/spec structures; the
// authoritative runtime validators are the TypeBox schemas in packages/reporting/src/schemas
// (§4.2). Kept minimal-but-real (no `any`) so the Drizzle `$type<...>()` generics carry real
// shape. NB filename deliberately omits the word "schema" (table-ownership filename gotcha).

/** A selectable dimension exposed by a report base (report_base_catalog.dimensions[]). */
export interface DimensionCatalog {
  dimensionKey: string;
  displayName: string;
  dataType: "string" | "number" | "boolean" | "date" | "uuid";
  description?: string;
}

/** A selectable measure exposed by a report base (report_base_catalog.measures[]). */
export interface MeasureCatalog {
  measureKey: string;
  displayName: string;
  metricKey: string; // logical ref into report_metric_catalog.metric_key
  unit: "count" | "rate_pct" | "currency_cents" | "minutes" | "days" | "ratio";
  aggregation: "sum" | "avg" | "count_distinct" | "max" | "min" | "percentile";
  description?: string;
}

export type FilterComparator =
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "in"
  | "not_in"
  | "between"
  | "is_null"
  | "is_not_null";

export type FilterValue = string | number | boolean | string[] | number[] | [string, string];

/** A single filter clause (report_view.pinned_filters[] / ReportDefinitionSpec.filters[]). */
export interface ReportFilter {
  dimensionKey: string;
  comparator: FilterComparator;
  value?: FilterValue;
}

export interface DimensionRef {
  dimensionKey: string;
  alias?: string;
}

export interface MeasureRef {
  measureKey: string;
  alias?: string;
}

export interface SortRef {
  by: string; // dimensionKey or measureKey
  direction: "asc" | "desc";
}

export type ChartHint = "table" | "bar" | "line" | "area" | "pie" | "kpi_tile" | "heatmap";

/** The persisted report definition spec (report_definition_version.spec). Mirrors §4.2. */
export interface ReportDefinitionSpec {
  dimensions: DimensionRef[];
  measures: MeasureRef[];
  filters: ReportFilter[];
  sort?: SortRef[];
  rowLimit?: number;
  chartHint?: ChartHint;
}
