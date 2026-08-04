// @wardenx/reporting — translator step 5: compose validator + filter-compiler + scope-injector into a
// final PARAMETERIZED `SELECT` against the base's MV (M33 §4, D4 + D6).
//
// The whole point of M33: a tenant supplies ONLY a typed spec + a base key; this function emits a single
// parameterized SQL string whose every table/column identifier comes from the platform-shipped catalog
// whitelist and whose every value is a bound `$n` parameter. There is NO raw-SQL surface and NO string
// interpolation of tenant values.
//
// Key invariants enforced here:
//   • The MV is NEVER selected directly. The FROM clause calls the SECURITY DEFINER wrapper function
//     `report_mv.select_<mvKey>(p_org_id)` (§3 / §8.1.1) — the org GUC check lives inside the wrapper,
//     so even a translator bug cannot cross tenants.
//   • Only catalog columns may appear. Each dimension/measure key is resolved against the base catalog;
//     any key not in the catalog throws `COLUMN_NOT_WHITELISTED`. Every emitted identifier passes
//     `quoteIdent` (the `^[a-z_][a-z0-9_]*$` guard) — including tenant-supplied aliases.
//   • Aggregate-by-default (D6): dimensions become the GROUP BY; measures become aggregate expressions.
//     No row-level column is ever projected un-aggregated, so no row-level PHI can leave.
//   • A base whose MV status is `registered` (the upstream producer has not landed) yields a
//     forward-seam DENY-STUB result instead of SQL — the tile renders "Not yet available — M<n> required".
import type { schema } from "@wardenx/db";
import { type CompiledWhere, REL_ALIAS, compileFilters } from "./filter-compiler";
import { type ReportableScopeEnvelope, injectScope } from "./scope-injector";
import {
  ReportTranslatorError,
  type TranslatorBaseCatalog,
  quoteIdent,
  validateSpecAgainstBase,
} from "./spec-validator";

/** One projected output column, paired so `result-shaper.ts` can map SQL rows back to typed cells. */
export interface TileColumn {
  /** The output alias the SELECT emits (tenant alias if supplied, else the catalog key). */
  readonly outputKey: string;
  /** The catalog key this column derives from. */
  readonly sourceKey: string;
  readonly kind: "dimension" | "measure";
  /** Present for measures: the unit the catalog declares (for tile formatting). */
  readonly unit?: schema.MeasureCatalog["unit"];
}

/** A compiled, ready-to-prepare parameterized query. */
export interface TranslatedSql {
  readonly kind: "sql";
  /** The parameterized `SELECT` text. Prepared with the read-replica session GUC active (D3). */
  readonly sql: string;
  /** Bound parameters in `$1…$n` order. `$1` is always the MV wrapper's `p_org_id`. */
  readonly params: unknown[];
  /** Output-column metadata, in SELECT order. */
  readonly columns: readonly TileColumn[];
  readonly mvKey: string;
  readonly baseKey: string;
  readonly rowLimit: number;
  readonly drilldownUrlTemplate: string | null;
}

/** The forward-seam deny-stub a `registered`-MV base yields instead of SQL (D6 — never fails open). */
export interface TranslatedDenyStub {
  readonly kind: "deny_stub";
  readonly isForwardSeamDenyStub: true;
  readonly mvKey: string;
  readonly baseKey: string;
}

export type Translation = TranslatedSql | TranslatedDenyStub;

/** SQL aggregate expression for a measure's declared aggregation over its whitelisted column. */
function aggExpr(aggregation: schema.MeasureCatalog["aggregation"], colSql: string): string {
  switch (aggregation) {
    case "sum":
      return `SUM(${colSql})`;
    case "avg":
      return `AVG(${colSql})`;
    case "count_distinct":
      return `COUNT(DISTINCT ${colSql})`;
    case "max":
      return `MAX(${colSql})`;
    case "min":
      return `MIN(${colSql})`;
    case "percentile":
      // Median (p50) — the platform's single percentile tier for tiles.
      return `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${colSql})`;
  }
}

/**
 * Translates a validated `spec` + resolved `base` + actor `scope` into a parameterized SELECT (or a
 * forward-seam deny-stub when the base's MV is not yet materialized). Pure — no DB access.
 *
 * Pipeline: spec-validator (§2.3) → deny-stub gate → SELECT/GROUP BY build (whitelist) →
 * filter-compiler (§4.2) → scope-injector (D8) → ORDER BY/LIMIT.
 */
export function translateSpec(
  spec: schema.ReportDefinitionSpec,
  base: TranslatorBaseCatalog,
  scope: ReportableScopeEnvelope,
): Translation {
  // 1. Semantic validation (§2.3) — throws BASE_NOT_ACTIVE / *_NOT_IN_BASE / FILTER_TYPE_MISMATCH /
  //    ROW_LIMIT_EXCEEDED. Runs BEFORE the deny-stub gate so a malformed spec is still rejected.
  const { effectiveRowLimit } = validateSpecAgainstBase(spec, base);

  // 2. Forward-seam deny-stub: a `registered` MV means the upstream producer has not landed.
  if (base.mvStatus === "registered") {
    return {
      kind: "deny_stub",
      isForwardSeamDenyStub: true,
      mvKey: base.mvKey,
      baseKey: base.baseKey,
    };
  }

  const dimByKey = new Map(base.dimensions.map((d) => [d.dimensionKey, d]));
  const measureByKey = new Map(base.measures.map((m) => [m.measureKey, m]));
  // dimensionKey → dataType, the whitelist the filter-compiler enforces against.
  const dimTypes = new Map(base.dimensions.map((d) => [d.dimensionKey, d.dataType]));

  // 3. SELECT list + output-column metadata. WHITELIST: every column resolves through the catalog map;
  //    an absent key throws COLUMN_NOT_WHITELISTED. Tenant aliases pass quoteIdent.
  const selectItems: string[] = [];
  const groupByItems: string[] = [];
  const columns: TileColumn[] = [];
  const outputKeys = new Set<string>();

  for (const ref of spec.dimensions) {
    const dim = dimByKey.get(ref.dimensionKey);
    if (!dim) {
      throw new ReportTranslatorError(
        "COLUMN_NOT_WHITELISTED",
        `Dimension "${ref.dimensionKey}" is not in base "${base.baseKey}".`,
      );
    }
    const colSql = `${REL_ALIAS}.${quoteIdent(dim.dimensionKey)}`;
    const outputKey = ref.alias ?? dim.dimensionKey;
    selectItems.push(`${colSql} AS ${quoteIdent(outputKey)}`);
    groupByItems.push(colSql);
    columns.push({ outputKey, sourceKey: dim.dimensionKey, kind: "dimension" });
    outputKeys.add(outputKey);
  }

  for (const ref of spec.measures) {
    const measure = measureByKey.get(ref.measureKey);
    if (!measure) {
      throw new ReportTranslatorError(
        "COLUMN_NOT_WHITELISTED",
        `Measure "${ref.measureKey}" is not in base "${base.baseKey}".`,
      );
    }
    const colSql = `${REL_ALIAS}.${quoteIdent(measure.measureKey)}`;
    const outputKey = ref.alias ?? measure.measureKey;
    selectItems.push(`${aggExpr(measure.aggregation, colSql)} AS ${quoteIdent(outputKey)}`);
    columns.push({ outputKey, sourceKey: measure.measureKey, kind: "measure", unit: measure.unit });
    outputKeys.add(outputKey);
  }

  // 4. FROM: the SECURITY DEFINER wrapper FUNCTION, never the raw MV. `p_org_id` binds as $1.
  const fnName = quoteIdent(`select_${base.mvKey}`);
  const schemaName = quoteIdent(base.mvSchemaName);
  const params: unknown[] = [scope.organizationId];
  const from = `${schemaName}.${fnName}($1) AS ${REL_ALIAS}`;

  // 5. WHERE = filters (start at $2) AND scope (D8). Both parameterized; scope columns are constants.
  const filterWhere: CompiledWhere = compileFilters(spec.filters, dimTypes, 2);
  params.push(...filterWhere.params);
  const scopeClause = injectScope(scope, filterWhere.nextIndex);
  params.push(...scopeClause.params);

  const wherePieces: string[] = [];
  if (filterWhere.sql.length > 0) wherePieces.push(filterWhere.sql);
  if (scopeClause.sql !== null) wherePieces.push(scopeClause.sql);
  const whereSql = wherePieces.length > 0 ? ` WHERE ${wherePieces.join(" AND ")}` : "";

  // 6. GROUP BY the dimension columns (aggregate-by-default, D6).
  const groupBySql = groupByItems.length > 0 ? ` GROUP BY ${groupByItems.join(", ")}` : "";

  // 7. ORDER BY — each `sort.by` must resolve to a projected output column (whitelist on output keys).
  let orderBySql = "";
  if (spec.sort && spec.sort.length > 0) {
    const orderItems = spec.sort.map((s) => {
      if (!outputKeys.has(s.by)) {
        throw new ReportTranslatorError(
          "SORT_KEY_NOT_IN_OUTPUT",
          `sort.by "${s.by}" is not a selected dimension/measure output.`,
        );
      }
      return `${quoteIdent(s.by)} ${s.direction === "desc" ? "DESC" : "ASC"}`;
    });
    orderBySql = ` ORDER BY ${orderItems.join(", ")}`;
  }

  // 8. LIMIT — bound as the final param (no inlined integer; every value binds).
  const limitIndex = scopeClause.nextIndex;
  params.push(effectiveRowLimit);
  const limitSql = ` LIMIT $${limitIndex}`;

  const sql = `SELECT ${selectItems.join(", ")} FROM ${from}${whereSql}${groupBySql}${orderBySql}${limitSql}`;

  return {
    kind: "sql",
    sql,
    params,
    columns,
    mvKey: base.mvKey,
    baseKey: base.baseKey,
    rowLimit: effectiveRowLimit,
    drilldownUrlTemplate: base.drilldownUrlTemplate ?? null,
  };
}
