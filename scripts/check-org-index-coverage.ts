/**
 * WardenX — Org-scoped RLS index coverage  (GAP-089; fitness gate)
 * ------------------------------------------------------------------
 * Every org-scoped table in this schema carries an RLS policy of the literal form
 *
 *     USING (organization_id = current_setting('app.org_id', true)::uuid)
 *
 * so `organization_id = $tenant` is a predicate Postgres AND-s onto EVERY statement against that
 * table — forever, for every caller. A table whose indexes never mention `organization_id` gives the
 * planner no way to prune by tenant: it reaches rows through some other column's index, or it scans
 * the table and discards other tenants' rows one at a time. That second case degrades in exact
 * proportion to how many OTHER tenants share the deployment, which is the one number a multi-tenant
 * SaaS cannot control. It is also invisible: the query is correct, the tests pass, and nothing goes
 * red until a large tenant lands next to a small one in production.
 *
 * That is how 151 of 395 org-scoped tables came to have `organization_id` in no index at all
 * (GAP-089) — 13 of them with no index whatsoever beyond the primary key on `id`. Migration 0207
 * fixed the corpus; this gate is what stops it recurring, since the cost of a new table shipping
 * without one is paid months later by someone who cannot see the cause.
 *
 * THE RULE: `organization_id` must appear among the FIRST TWO key columns of at least one index on
 * the table (counting a PRIMARY KEY / UNIQUE constraint as the index it creates).
 *
 * Not "leading", and not merely "present somewhere". Leading is the ideal but would reject six
 * legitimate existing designs where the leading column is itself the selective one and org is the
 * second key — `membership (user_id, organization_id)`, `feature_flag (flag_key, organization_id)`,
 * `report_schedule_run (status, organization_id)`, and the composite partitioned primary keys
 * `(id, organization_id[, …])`. Those prune fine. "Present somewhere" is too weak in the other
 * direction: `(patient_id, encounter_id, organization_id)` prunes by tenant not at all, because a
 * btree can only seek on a prefix of its key. First-two is the line that admits every honest design
 * and rejects the accident.
 *
 * NO EXEMPTION LIST — deliberately, the same posture as arch:abac-predicates. The fix for a flagged
 * table is one line of DDL in a migration, so an escape hatch would only ever be used to defer it.
 *
 * PARSES THE .sql MIGRATION CORPUS, not the Drizzle schema and not a live database: the gate has to
 * run in `build-and-verify`, which has no Postgres. The parser was validated against the real
 * catalog — `pg_index` / `pg_attribute` on a freshly migrated database — and agrees with it table
 * for table and verdict for verdict (see __tests__/check-org-index-coverage.test.ts).
 *
 * Run:   bun run arch:org-indexes
 * CI:    exits 1 on any org-scoped table with no qualifying index.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const MIGRATIONS_DIR = join(REPO_ROOT, "packages", "db", "migrations");
const ORG_COL = "organization_id";
/** How far into an index key `organization_id` may sit and still prune — see header. */
export const MAX_ORG_KEY_POSITION = 2;

export interface OrgIndexCoverage {
  /** Org-scoped tables (an `organization_id` column) that are not partitions of another table. */
  readonly orgTables: readonly string[];
  /** Org-scoped tables with no index placing `organization_id` in the first two key columns. */
  readonly uncovered: readonly string[];
}

/** Strip SQL line comments and block comments so their prose never parses as DDL. */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** The substring of `sql` inside the parenthesis opening at `open`, honoring nesting. */
function balanced(sql: string, open: number): { body: string; end: number } | null {
  if (sql[open] !== "(") return null;
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      depth--;
      if (depth === 0) return { body: sql.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Split a parenthesized list on top-level commas (so `numeric(12, 2)` stays one item). */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const unquote = (name: string): string => name.replace(/^"(.*)"$/, "$1").toLowerCase();

/**
 * The key columns of an index/constraint column list, in order. Expression keys (`lower(x)`,
 * `(a || b)`) are kept as opaque placeholders so they still consume a key POSITION — an expression
 * ahead of `organization_id` pushes it further from the prefix exactly as a plain column does.
 */
function keyColumns(body: string): string[] {
  return splitTopLevel(body).map((item) => {
    const m =
      /^("[^"]+"|[a-z_][a-z0-9_$]*)\s*(?:(?:asc|desc)\b)?\s*(?:nulls\s+(?:first|last)\b)?\s*$/i.exec(
        item,
      );
    return m ? unquote(m[1] as string) : "«expr»";
  });
}

/** Parse the whole migration corpus into org-scoped tables and their index key columns. */
export function analyzeMigrations(dir: string = MIGRATIONS_DIR): OrgIndexCoverage {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const orgTables = new Set<string>();
  /** Tables created as `PARTITION OF` another — they inherit the parent's indexes. */
  const partitions = new Set<string>();
  /** table → each index's ordered key columns. */
  const indexes = new Map<string, string[][]>();

  const addIndex = (table: string, cols: string[]): void => {
    const list = indexes.get(table) ?? [];
    list.push(cols);
    indexes.set(table, list);
  };

  for (const file of files) {
    const sql = stripComments(readFileSync(join(dir, file), "utf8"));

    // ── CREATE TABLE [IF NOT EXISTS] "t" ( … )  /  … PARTITION OF parent ──────────────────
    const createRe = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[a-z_][a-z0-9_$]*)/gi;
    let cm: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
    while ((cm = createRe.exec(sql))) {
      const table = unquote(cm[1] as string);
      // `PARTITION OF` must be looked for ONLY between the table name and whatever ends the
      // statement's head — the first `(` or `;`. A fixed-width lookahead window spills into the
      // NEXT statement, and `CREATE TABLE evt (…) PARTITION BY RANGE (at);` followed later by
      // `CREATE TABLE evt_2026 PARTITION OF evt` would then classify the PARENT as a partition and
      // drop it from coverage entirely.
      const open = sql.indexOf("(", createRe.lastIndex);
      const semi = sql.indexOf(";", createRe.lastIndex);
      const headEnd = Math.min(open === -1 ? sql.length : open, semi === -1 ? sql.length : semi);
      if (/\bPARTITION\s+OF\b/i.test(sql.slice(createRe.lastIndex, headEnd))) {
        partitions.add(table);
        continue;
      }
      if (open === -1) continue;
      const block = balanced(sql, open);
      if (!block) continue;
      for (const item of splitTopLevel(block.body)) {
        // Inline PRIMARY KEY (…) / UNIQUE (…) — with or without a CONSTRAINT name.
        const con =
          /^(?:CONSTRAINT\s+(?:"[^"]+"|[a-z_][a-z0-9_$]*)\s+)?(PRIMARY\s+KEY|UNIQUE)\s*\(/i.exec(
            item,
          );
        if (con) {
          const inner = balanced(item, item.indexOf("(", con[0].length - 1));
          if (inner) addIndex(table, keyColumns(inner.body));
          continue;
        }
        // A column definition — `"organization_id" uuid NOT NULL …`. A column-level PRIMARY
        // KEY/UNIQUE on it is a single-column index on that column.
        const colDef = /^("[^"]+"|[a-z_][a-z0-9_$]*)\s+\S/.exec(item);
        if (!colDef) continue;
        const col = unquote(colDef[1] as string);
        if (/^(constraint|primary|unique|check|foreign|exclude|like|partition)$/i.test(col))
          continue;
        if (col === ORG_COL) orgTables.add(table);
        if (/\b(PRIMARY\s+KEY|UNIQUE)\b/i.test(item)) addIndex(table, [col]);
      }
    }

    // ── ALTER TABLE … ADD COLUMN organization_id ──────────────────────────────────────────
    const addColRe =
      /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|[a-z_][a-z0-9_$]*)[\s\S]{0,200}?\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[a-z_][a-z0-9_$]*)/gi;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
    while ((cm = addColRe.exec(sql))) {
      if (unquote(cm[2] as string) === ORG_COL) orgTables.add(unquote(cm[1] as string));
    }

    // ── ALTER TABLE … ADD CONSTRAINT … PRIMARY KEY/UNIQUE (…) ─────────────────────────────
    const addConRe =
      /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?("[^"]+"|[a-z_][a-z0-9_$]*)[\s\S]{0,300}?\bADD\s+(?:CONSTRAINT\s+(?:"[^"]+"|[a-z_][a-z0-9_$]*)\s+)?(?:PRIMARY\s+KEY|UNIQUE)\s*\(/gi;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
    while ((cm = addConRe.exec(sql))) {
      const inner = balanced(sql, addConRe.lastIndex - 1);
      if (inner) addIndex(unquote(cm[1] as string), keyColumns(inner.body));
    }

    // ── CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] n ON [ONLY] t [USING m] (…) ──
    const idxRe =
      /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"[^"]+"|[a-z_][a-z0-9_$]*)?\s*ON\s+(?:ONLY\s+)?("[^"]+"|[a-z_][a-z0-9_$]*)\s*(?:USING\s+[a-z_]+\s*)?\(/gi;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec() iteration.
    while ((cm = idxRe.exec(sql))) {
      const inner = balanced(sql, idxRe.lastIndex - 1);
      if (inner) addIndex(unquote(cm[1] as string), keyColumns(inner.body));
    }
  }

  const tables = [...orgTables].filter((t) => !partitions.has(t)).sort();
  const uncovered = tables.filter((table) => {
    const list = indexes.get(table) ?? [];
    return !list.some((cols) => cols.slice(0, MAX_ORG_KEY_POSITION).includes(ORG_COL));
  });
  return { orgTables: tables, uncovered };
}

function main(): void {
  const { orgTables, uncovered } = analyzeMigrations();
  if (uncovered.length === 0) {
    console.log(
      `✓ org-index coverage: all ${orgTables.length} org-scoped tables index organization_id within the first ${MAX_ORG_KEY_POSITION} key columns.`,
    );
    return;
  }
  console.error(
    `✗ org-index coverage: ${uncovered.length} of ${orgTables.length} org-scoped tables have NO index placing organization_id in the first ${MAX_ORG_KEY_POSITION} key columns.\n`,
  );
  for (const t of uncovered) console.error(`   • ${t}`);
  console.error(
    `\nEvery statement against these tables carries the RLS predicate organization_id = current_setting('app.org_id')::uuid,` +
      "\nand the planner has no way to prune by tenant without such an index. Add one in a migration:" +
      `\n\n    CREATE INDEX IF NOT EXISTS "<table>_org_ix" ON "<table>" ("organization_id", "<created_at|event time>");\n` +
      "\nsee packages/db/migrations/0207_org_scoped_rls_indexes.sql for the shape and the reasoning.",
  );
  process.exit(1);
}

if (import.meta.main) main();
