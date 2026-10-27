/**
 * ChartWarden — migration expand/contract compatibility gate  (#861, CW-QA-0017)
 * ---------------------------------------------------------------------------
 * Migrations are forward-only and commit one file at a time. When a deploy fails AFTER migrating,
 * `deploy/production/deploy.sh` must decide whether the PREVIOUS image may run against the schema it
 * left behind. That is safe only if every migration the deploy applied was expand-phase (additive: the
 * old code still works). This gate turns that from a hope into a declaration a machine checks.
 *
 * THE CONTRACT. Every migration with an ordinal >= COMPAT_DECLARATION_FROM carries, in its leading
 * comment block, exactly one of:
 *     -- compat: expand     old code keeps working on the new schema (auto-rollback allowed)
 *     -- compat: contract   it does not, or you are not sure (auto-rollback refused)
 * Older files are grandfathered: they are not edited, and deploy.sh treats them as undeclared
 * (= not expand), which can only make a rollback MORE careful.
 *
 * THE HEURISTIC. An `expand` claim is checked against obviously contracting statements: DROP of a
 * table, view, function, type, schema, sequence, index, policy, trigger, role, extension (and similar),
 * column or constraint; ADD CONSTRAINT (enforced against old writes even NOT VALID); CREATE UNIQUE INDEX;
 * REVOKE; TRUNCATE; DELETE FROM; ALTER ROLE; any RENAME or SET SCHEMA; ALTER COLUMN ... TYPE; ALTER
 * COLUMN ... DROP DEFAULT; SET NOT NULL with no DEFAULT set on that table.column in the same file;
 * ADD COLUMN ... NOT NULL with no DEFAULT. It is a deliberately conservative text heuristic, not a SQL
 * parser: it strips comments but not dollar-quoted bodies, so a statement inside a function body is
 * judged too (declare `contract` — the safe direction). It cannot see semantic changes (a column whose
 * meaning changed, a replaced function's behaviour, an UPDATE that rewrites values); those stay the
 * author's and reviewer's call, which is why `contract` is always an acceptable answer.
 *
 * Run:  bun run arch:migration-compat   (in `arch:fitness`)
 * Deploy use:  bun run scripts/check-migration-compat.ts --classify <file.sql>...
 *   exits 0 only if EVERY named file is declared `expand` AND passes the heuristic; 1 otherwise.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT =
  process.env.CHARTWARDEN_FITNESS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "packages", "db", "migrations");

/** First ordinal that must declare. Everything below it predates the contract and is grandfathered. */
export const COMPAT_DECLARATION_FROM = 1288;

export type Compat = "expand" | "contract";
export interface CompatReport {
  readonly declared: Compat | "missing" | `invalid:${string}`;
  readonly contracting: readonly string[];
}

const ORDINAL = /^(\d{4})_[a-z0-9][a-z0-9_]*\.sql$/;

export function ordinalOf(filename: string): number | null {
  const m = ORDINAL.exec(filename);
  return m ? Number(m[1]) : null;
}

/** The `-- compat:` value from the leading comment block (blank and `--` lines before the first SQL). */
export function parseDeclaration(sql: string): CompatReport["declared"] {
  const found: string[] = [];
  for (const raw of sql.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    if (!line.startsWith("--")) break;
    const m = /^--\s*compat\s*:\s*(\S+)/i.exec(line);
    if (m) found.push((m[1] as string).toLowerCase());
  }
  if (found.length === 0) return "missing";
  if (found.length > 1) return `invalid:${found.join(",")}`;
  const value = found[0] as string;
  return value === "expand" || value === "contract" ? value : `invalid:${value}`;
}

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Split on commas that are not inside parentheses (ALTER TABLE clause lists). */
function topLevelClauses(stmt: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) {
      out.push(stmt.slice(start, i));
      start = i + 1;
    }
  }
  out.push(stmt.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const DROP_OBJECT =
  /\bDROP\s+(TABLE|VIEW|MATERIALIZED\s+VIEW|FUNCTION|PROCEDURE|TYPE|DOMAIN|SCHEMA|SEQUENCE|INDEX|POLICY|TRIGGER|ROLE|EXTENSION|OWNED|RULE|AGGREGATE|OPERATOR|CAST)\b/;
/** Statements that take something away from code already running: privileges, rows, uniqueness, role settings. */
const OTHER_CONTRACTING: readonly (readonly [RegExp, string])[] = [
  [/\bREVOKE\b/, "REVOKE"],
  [/\bTRUNCATE\b/, "TRUNCATE"],
  [/\bDELETE\s+FROM\b/, "DELETE FROM"],
  [/\bCREATE\s+UNIQUE\s+INDEX\b/, "CREATE UNIQUE INDEX"],
  [/\bALTER\s+ROLE\b/, "ALTER ROLE"],
];
const ALTER_TABLE_PREFIX = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(\S+)\s+/;
const ALTER_COLUMN = /ALTER\s+(?:COLUMN\s+)?("?[A-Z0-9_]+"?)\s+(.*)$/;

/** `"public"."foo"` / `public.foo` / `foo` -> `FOO` (statements are already upper-cased). */
function tableKey(name: string): string {
  return name.replace(/"/g, "").replace(/^PUBLIC\./, "");
}

/** `table.column` pairs given a DEFAULT anywhere in the file (SET NOT NULL on them is not flagged). */
function defaultedColumns(statements: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const s of statements) {
    const at = s.search(/\bALTER\s+TABLE\s/);
    const table = at < 0 ? null : ALTER_TABLE_PREFIX.exec(s.slice(at));
    if (!table) continue;
    for (const m of s.matchAll(/ALTER\s+(?:COLUMN\s+)?("?[A-Z0-9_]+"?)\s+SET\s+DEFAULT\b/g)) {
      out.add(`${table[1]}.${m[1]}`);
    }
  }
  return out;
}

/** Every obviously contracting statement in `sql`, as short human-readable findings. */
export function findContractingDdl(sql: string): string[] {
  // Dollar-quote delimiters split too, so a function/DO body's statements are judged on their own.
  const statements = stripComments(sql)
    .split(/;|\$[A-Za-z_]*\$/)
    .map((s) => s.replace(/\s+/g, " ").trim().toUpperCase())
    .filter(Boolean);
  const defaulted = defaultedColumns(statements);
  // Tables this file creates: no previous release can use them, so constraints, unique indexes, triggers
  // and policies on them (including the usual DROP ... IF EXISTS before CREATE) take nothing away.
  const created = new Set(
    statements.flatMap((s) => {
      const m = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/.exec(s);
      return m ? [tableKey(m[1] as string)] : [];
    }),
  );
  const onNewTable = (stmt: string): boolean => {
    const m = /\bON\s+(?:ONLY\s+)?([^\s(]+)/.exec(stmt);
    return m !== null && created.has(tableKey(m[1] as string));
  };
  const findings: string[] = [];
  const flag = (why: string, stmt: string): void => {
    findings.push(`${why}: ${stmt.slice(0, 120)}`);
  };

  for (const statement of statements) {
    let stmt = statement;
    const drop = DROP_OBJECT.exec(stmt);
    const scopedToNewTable = /^(INDEX|POLICY|TRIGGER)$/.test(drop?.[1] ?? "") && onNewTable(stmt);
    if (drop && !scopedToNewTable) flag(`DROP ${drop[1]}`, stmt);
    for (const [re, why] of OTHER_CONTRACTING) {
      if (re.test(stmt) && !(why === "CREATE UNIQUE INDEX" && onNewTable(stmt))) flag(why, stmt);
    }
    // Judge an ALTER wherever it starts (a body statement can follow BEGIN / THEN / EXECUTE).
    const at = stmt.search(/\bALTER\s/);
    if (at < 0) continue;
    stmt = stmt.slice(at);
    if (/\bRENAME\b/.test(stmt)) flag("RENAME", stmt);
    if (/\bSET\s+SCHEMA\b/.test(stmt)) flag("SET SCHEMA", stmt);
    const table = ALTER_TABLE_PREFIX.exec(stmt);
    if (!table || created.has(tableKey(table[1] as string))) continue;
    const clauses = topLevelClauses(stmt.replace(ALTER_TABLE_PREFIX, ""));
    for (const clause of clauses) {
      if (/^DROP\s+/.test(clause)) {
        flag(/^DROP\s+CONSTRAINT\b/.test(clause) ? "DROP CONSTRAINT" : "DROP COLUMN", stmt);
        continue;
      }
      // A new constraint is enforced against the old code's writes too (even NOT VALID).
      if (/^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/.test(clause)) {
        flag("ADD CONSTRAINT", stmt);
        continue;
      }
      if (/^ADD\s+/.test(clause)) {
        // `ON DELETE SET DEFAULT` is a referential action, not a column default.
        const definition = clause.replace(/\bON\s+(DELETE|UPDATE)\s+SET\s+DEFAULT\b/g, "");
        if (/\bNOT\s+NULL\b/.test(definition) && !/\b(DEFAULT|GENERATED)\b/.test(definition)) {
          flag("ADD COLUMN NOT NULL without DEFAULT", stmt);
        }
        continue;
      }
      const alter = ALTER_COLUMN.exec(clause);
      if (!alter || !clause.startsWith("ALTER ")) continue;
      const [, column, action] = alter as unknown as [string, string, string];
      if (/^(SET\s+DATA\s+)?TYPE\b/.test(action)) flag("ALTER COLUMN TYPE", stmt);
      if (/^DROP\s+DEFAULT\b/.test(action)) flag("DROP DEFAULT", stmt);
      if (/^SET\s+NOT\s+NULL\b/.test(action) && !defaulted.has(`${table[1]}.${column}`)) {
        flag("SET NOT NULL without DEFAULT", stmt);
      }
    }
  }
  return findings;
}

export function assess(sql: string): CompatReport {
  return { declared: parseDeclaration(sql), contracting: findContractingDdl(sql) };
}

/** True only when the file declares `expand` and the heuristic finds nothing that contradicts it. */
export function isExpandSafe(report: CompatReport): boolean {
  return report.declared === "expand" && report.contracting.length === 0;
}

/** Gate errors for one file; grandfathered files produce none. */
export function gateErrors(filename: string, sql: string): string[] {
  const ordinal = ordinalOf(filename);
  if (ordinal === null || ordinal < COMPAT_DECLARATION_FROM) return [];
  const report = assess(sql);
  if (report.declared === "missing") {
    return [`${filename}: missing '-- compat: expand' or '-- compat: contract' in its header`];
  }
  if (report.declared.startsWith("invalid:")) {
    return [
      `${filename}: compat declaration must be exactly one of expand|contract (${report.declared})`,
    ];
  }
  if (report.declared === "expand" && report.contracting.length > 0) {
    return report.contracting.map(
      (f) => `${filename}: declared expand but contains contracting DDL — ${f}`,
    );
  }
  return [];
}

function readSql(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

function classify(files: readonly string[]): number {
  let allExpand = files.length > 0;
  for (const file of files) {
    let verdict: string;
    if (ordinalOf(file) === null) {
      verdict = "unknown (not a migration filename)";
    } else {
      try {
        const report = assess(readSql(file));
        verdict = isExpandSafe(report)
          ? "expand"
          : report.declared === "expand"
            ? `contract (declared expand, but: ${report.contracting.join("; ")})`
            : report.declared === "contract"
              ? "contract"
              : `not expand (declaration ${report.declared})`;
      } catch {
        verdict = "unknown (file not found in this image)";
      }
    }
    if (verdict !== "expand") allExpand = false;
    console.log(`${file}\t${verdict}`);
  }
  return allExpand ? 0 : 1;
}

function main(): never {
  const args = process.argv.slice(2);
  if (args[0] === "--classify") process.exit(classify(args.slice(1)));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const errors = files.flatMap((f) => gateErrors(f, readSql(f)));
  const checked = files.filter((f) => (ordinalOf(f) ?? 0) >= COMPAT_DECLARATION_FROM).length;
  if (errors.length > 0) {
    console.error(`arch:migration-compat — ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(
      `Declare each migration from ${COMPAT_DECLARATION_FROM} on as '-- compat: expand' (old code still works) or '-- compat: contract'. See packages/db/migrations/README.md.`,
    );
    process.exit(1);
  }
  console.log(
    `arch:migration-compat ok — ${checked} migration(s) from ${COMPAT_DECLARATION_FROM} declare a valid compat; ` +
      `${files.length - checked} grandfathered.`,
  );
  process.exit(0);
}

if (import.meta.main) main();
