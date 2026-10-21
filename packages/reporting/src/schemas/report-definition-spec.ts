// @chartwarden/reporting — the `ReportDefinitionSpec` TypeBox schema (M33 §4.2).
//
// The runtime validator for a tenant-authored `report_definition_version.spec` (D4). A tenant never
// writes SQL: they pick a platform-shipped `report_base_key`, then select `dimensions[]` / `measures[]`
// from THAT base's catalog and apply typed `filters[]`. This file is the SHAPE gate (TypeBox); the
// SEMANTIC gate (every key present in the base catalog, every comparator legal for the dimension's
// type, rowLimit ≤ base.max_row_limit) is the `translator/spec-validator.ts` layer, and the WHITELIST
// gate (only catalog columns reach SQL, every value bound) is `translator/sql-translator.ts`. The
// authoritative row-stored shapes mirror these in `packages/db/src/schema/reporting/types.ts`.
import { type Static, Type } from "@sinclair/typebox";

export const DimensionRef = Type.Object({
  dimensionKey: Type.String(), // must be in base.dimensions[]
  alias: Type.Optional(Type.String()),
});

export const MeasureRef = Type.Object({
  measureKey: Type.String(), // must be in base.measures[]
  alias: Type.Optional(Type.String()),
});

export const FilterTypeBox = Type.Object({
  dimensionKey: Type.String(),
  comparator: Type.Union([
    Type.Literal("eq"),
    Type.Literal("ne"),
    Type.Literal("lt"),
    Type.Literal("le"),
    Type.Literal("gt"),
    Type.Literal("ge"),
    Type.Literal("in"),
    Type.Literal("not_in"),
    Type.Literal("between"),
    Type.Literal("is_null"),
    Type.Literal("is_not_null"),
  ]),
  value: Type.Optional(
    Type.Union([
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Array(Type.String()),
      Type.Array(Type.Number()),
      Type.Tuple([Type.String(), Type.String()]), // for between with date strings
    ]),
  ),
});

export const SortRef = Type.Object({
  by: Type.String(), // dimensionKey or measureKey
  direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
});

export const ReportDefinitionSpec = Type.Object({
  dimensions: Type.Array(DimensionRef, { maxItems: 8 }),
  measures: Type.Array(MeasureRef, { maxItems: 16, minItems: 1 }),
  filters: Type.Array(FilterTypeBox, { maxItems: 24, default: [] }),
  sort: Type.Optional(Type.Array(SortRef, { maxItems: 4 })),
  rowLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000, default: 1000 })),
  chartHint: Type.Optional(
    Type.Union([
      Type.Literal("table"),
      Type.Literal("bar"),
      Type.Literal("line"),
      Type.Literal("area"),
      Type.Literal("pie"),
      Type.Literal("kpi_tile"),
      Type.Literal("heatmap"),
    ]),
  ),
});

export type ReportDefinitionSpecT = Static<typeof ReportDefinitionSpec>;
