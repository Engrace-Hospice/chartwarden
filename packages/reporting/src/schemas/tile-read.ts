// @chartwarden/reporting — the tile-read TypeBox schemas (M33 §4.2).
//
// `TileReadQuery` is the per-request tile filter + scope-override input; `TileReadResponse` is the
// aggregate-only shape every M33 tile route returns (D6 — `result` carries aggregate rows, NEVER
// row-level PHI). `scopeApplied` reports the actor's resolved `reportable_scope` (and whether the
// requested scope was narrowed). The `result-shaper.ts` translator step produces `TileReadResponse`.
import { type Static, Type } from "@sinclair/typebox";
import { FilterTypeBox } from "./report-definition-spec";

export const TileReadQuery = Type.Object({
  filters: Type.Optional(Type.Array(FilterTypeBox, { maxItems: 24 })),
  scopeOverride: Type.Optional(
    Type.Union([
      Type.Literal("self"),
      Type.Literal("team"),
      Type.Literal("location"),
      Type.Literal("org"),
    ]),
  ), // requested scope; resolved against actor's reportable_scope envelope and narrowed if needed
  asOf: Type.Optional(Type.String({ format: "date-time" })), // for historical tile reads
});

export const TileReadResponse = Type.Object({
  tileKey: Type.String(),
  result: Type.Array(Type.Any()), // typed per the base; not row-level PHI by design
  rowCount: Type.Integer(),
  dataFreshnessSeconds: Type.Integer(),
  asOf: Type.String({ format: "date-time" }),
  drilldownUrlTemplate: Type.Optional(Type.String()),
  scopeApplied: Type.Object({
    scopeKind: Type.Union([
      Type.Literal("self"),
      Type.Literal("team"),
      Type.Literal("location"),
      Type.Literal("org"),
    ]),
    narrowedFromRequested: Type.Boolean(),
  }),
});

export type TileReadQueryT = Static<typeof TileReadQuery>;
export type TileReadResponseT = Static<typeof TileReadResponse>;
