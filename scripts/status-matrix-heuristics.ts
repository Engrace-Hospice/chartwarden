/**
 * Pure helpers for `report-implementation-status.ts` (kept import-safe: the report itself runs on import).
 */

import { parseCreateTables } from "./lib/gate-scan";

// `EXECUTE format('CREATE TABLE IF NOT EXISTS %I …')` parses as a table named `IF`.
const RESERVED = new Set(["if", "not", "exists"]);

// `DO $$ ... FOREACH s IN ARRAY ARRAY['a','b'] LOOP t := 'prefix_' || s; EXECUTE format('CREATE TABLE ... %I', t ...)`:
// one loop creates a family of tables (M38's per-system `concept_*` tables). A literal CREATE TABLE scan misses them.
const LOOPED_CREATE_RE =
  /foreach\s+(\w+)\s+in\s+array\s+array\s*\[([^\]]*)\]\s+loop\s+(\w+)\s*:=\s*'(\w*)'\s*\|\|\s*\1\s*;\s*execute\s+format\(\s*'\s*create\s+table/gi;

/** Table names a migration's SQL creates: literal `CREATE TABLE` (partition children skipped) plus looped creates. */
export function createdTablesIn(sql: string): string[] {
  const out = parseCreateTables(sql)
    // a partition child belongs to its owned parent
    .filter((t) => !t.isPartition && !RESERVED.has(t.name.toLowerCase()))
    .map((t) => t.name);
  for (const m of sql.matchAll(LOOPED_CREATE_RE)) {
    for (const item of m[2]!.matchAll(/'(\w+)'/g)) out.push(`${m[4]}${item[1]}`);
  }
  return out;
}
