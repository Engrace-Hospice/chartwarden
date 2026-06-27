// @wardenx/reporting — the report-builder translator barrel (M33 §4, D4 + D6).
//
// The spec→SQL pipeline that gives M33 its "no raw-SQL surface" guarantee: a tenant authors a typed
// `ReportDefinitionSpec` against a platform-shipped base; this pipeline compiles it into a single
// parameterized `SELECT` against the base's SECURITY DEFINER MV wrapper using ONLY whitelisted catalog
// columns, with every tenant value bound as a `$n` parameter.
//
//   spec-validator  — §2.3 semantic validation (throws BASE_NOT_ACTIVE / *_NOT_IN_BASE /
//                      FILTER_TYPE_MISMATCH / ROW_LIMIT_EXCEEDED); owns the domain error class, the
//                      comparator-by-type table, and the SQL-identifier whitelist guard.
//   filter-compiler — filters[] → parameterized WHERE fragment ($n placeholders; never interpolated).
//   scope-injector  — reportable_scope envelope → additional parameterized WHERE predicate (D8).
//   sql-translator  — composes the above into the final SELECT against report_mv.select_<mvKey>(p_org_id),
//                     or a forward-seam deny-stub for a not-yet-materialized base.
//   result-shaper   — SQL rows → typed TileReadResponse (aggregate-only, D6).
export * from "./spec-validator";
export * from "./filter-compiler";
export * from "./scope-injector";
export * from "./sql-translator";
export * from "./result-shaper";
