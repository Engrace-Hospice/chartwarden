// @wardenx/reporting — translator step 6: map executed SQL rows to the typed `TileReadResponse`
// (M33 §4.2, D6).
//
// The query the SQL step emits aggregates by design, so the rows it returns carry NO row-level PHI —
// only the projected dimension/measure output columns. This step shapes those rows into the §4.2
// `TileReadResponse`: it projects each row down to exactly the translator's known output keys (so a
// stray column from a future MV change can never leak), and stamps freshness/as-of/scope metadata. A
// forward-seam deny-stub shapes to an empty result with no drilldown.
import type { TileReadResponseT } from "../schemas/tile-read";
import type { ReportScopeKind } from "./scope-injector";
import type { Translation } from "./sql-translator";

/** A raw SQL row as returned by the pg driver (keyed by the SELECT output aliases). */
export type SqlRow = Record<string, unknown>;

/** The per-request metadata the route supplies around the translated query result. */
export interface TileShapeContext {
  readonly tileKey: string;
  /** Replica-lag-derived freshness for the "Data as of HH:MM" badge (D14). */
  readonly dataFreshnessSeconds: number;
  /** ISO timestamp the tile is "as of" (historical reads pin this). */
  readonly asOf: string;
  readonly scopeApplied: {
    readonly scopeKind: ReportScopeKind;
    readonly narrowedFromRequested: boolean;
  };
}

/**
 * Shapes a `Translation` + its executed rows into the typed §4.2 `TileReadResponse`. For a deny-stub the
 * rows are ignored and an empty result is returned. For SQL, each row is projected to exactly the
 * translator's output keys (defense against an MV exposing more columns than the catalog whitelists).
 * Pure — no DB access.
 */
export function shapeTileResult(
  translation: Translation,
  rows: readonly SqlRow[],
  ctx: TileShapeContext,
): TileReadResponseT {
  if (translation.kind === "deny_stub") {
    return {
      tileKey: ctx.tileKey,
      result: [],
      rowCount: 0,
      dataFreshnessSeconds: ctx.dataFreshnessSeconds,
      asOf: ctx.asOf,
      scopeApplied: ctx.scopeApplied,
    };
  }

  const outputKeys = translation.columns.map((c) => c.outputKey);
  const result = rows.map((row) => {
    const projected: SqlRow = {};
    for (const key of outputKeys) projected[key] = row[key];
    return projected;
  });

  const response: TileReadResponseT = {
    tileKey: ctx.tileKey,
    result,
    rowCount: result.length,
    dataFreshnessSeconds: ctx.dataFreshnessSeconds,
    asOf: ctx.asOf,
    scopeApplied: ctx.scopeApplied,
  };
  if (translation.drilldownUrlTemplate !== null) {
    response.drilldownUrlTemplate = translation.drilldownUrlTemplate;
  }
  return response;
}
