/**
 * Pure helpers for `report-implementation-status.ts` (kept import-safe: the report itself runs on import).
 */

const CREATE_TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?([^;]*)/gi;
const RESERVED = new Set(["if", "not", "exists"]);

// `DO $$ ... FOREACH s IN ARRAY ARRAY['a','b'] LOOP t := 'prefix_' || s; EXECUTE format('CREATE TABLE ... %I', t ...)`:
// one loop creates a family of tables (M38's per-system `concept_*` tables). A literal CREATE TABLE scan misses them.
const LOOPED_CREATE_RE =
  /foreach\s+(\w+)\s+in\s+array\s+array\s*\[([^\]]*)\]\s+loop\s+(\w+)\s*:=\s*'(\w*)'\s*\|\|\s*\1\s*;\s*execute\s+format\(\s*'\s*create\s+table/gi;

/** Table names a migration's SQL creates: literal `CREATE TABLE` (partition children skipped) plus looped creates. */
export function createdTablesIn(sql: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(CREATE_TABLE_RE)) {
    const name = m[1]!;
    if (RESERVED.has(name.toLowerCase())) continue;
    if (/partition\s+of/i.test(m[2]!)) continue; // partition child belongs to its owned parent
    out.push(name);
  }
  for (const m of sql.matchAll(LOOPED_CREATE_RE)) {
    for (const item of m[2]!.matchAll(/'(\w+)'/g)) out.push(`${m[4]}${item[1]}`);
  }
  return out;
}
