// apps/backend/src/modules/33-reporting/sql-executor.ts — the one Drizzle-backed executor for a
// `translateSpec` result.
//
// Extracted from wiring.ts (GAP-051) because the SCHEDULED path needs it too: the `report.scheduled_run`
// worker's `SnapshotQueryPort` must materialize the snapshot it hands to M22, and it had no way to run a
// translation. One executor, three callers — the read service's tiles, the export service's CSV/PDF/XLSX
// snapshot, and the scheduled runner's.
import { sql } from "drizzle-orm";

import type { ExportSqlExecutor, TileSqlExecutor } from "./routes/index";

/**
 * Reconstruct `translateSpec`'s parameterized SQL text (literal `$1, $2, … $n` placeholders + a matching
 * `params` array, kept SEPARATE by design — D4, no raw-SQL/string-interpolated values) as a real
 * drizzle-orm `SQL` object `db.execute` can run. drizzle-orm's public API has no "text + params array"
 * constructor (`sql.raw(str)` is TEXT-ONLY, no param binding), so this splits the text on its `$<n>`
 * markers and rebuilds the query as a `sql.join` of alternating raw-text `sql.raw()` chunks and bound
 * `` sql`${value}` `` param chunks, in the SAME left-to-right order the text already encodes — drizzle then
 * re-numbers those chunks into `$1, $2, …` on render, which is identical to the input numbering because the
 * chunk order matches it exactly. Every bound value still passes through drizzle's own parameter binding
 * (a real `pg` driver parameter, never string-interpolated) — this is a re-encoding of the SAME
 * already-safe parameterized query, not a new SQL-construction surface.
 */
export function toParameterizedSql(text: string, params: readonly unknown[]) {
  const parts = text.split(/\$(\d+)/);
  const chunks: ReturnType<typeof sql.raw>[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (part === undefined) continue;
    if (i % 2 === 0) {
      if (part.length > 0) chunks.push(sql.raw(part));
    } else {
      const value = params[Number(part) - 1];
      chunks.push(sql`${value}`);
    }
  }
  return sql.join(chunks);
}

/**
 * The real Drizzle-backed {@link TileSqlExecutor} / {@link ExportSqlExecutor} — executes a `translateSpec`
 * result on the CALLER-SUPPLIED `db` (the active `withReportSession` / `withOrgContext` tx), never a
 * statically-captured connection (see both interfaces' doc comments for why that would silently defeat
 * RLS). One executor, two ports with the same shape.
 */
export function buildDrizzleTileSqlExecutor(): TileSqlExecutor & ExportSqlExecutor {
  return {
    async execute(db, { sql: text, params }) {
      const result = await db.execute(toParameterizedSql(text, params));
      const rows = result.rows;
      return { rows, rowCount: result.rowCount ?? rows.length };
    },
  };
}
