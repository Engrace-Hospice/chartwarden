/**
 * ChartWarden — shared source-scanning primitives for the arch:* gate scripts.
 *
 * Each gate used to carry its own recursive walker, migration lister, SQL comment stripper and
 * `CREATE TABLE` / `pgTable(` regex, and the copies had drifted. Put a new scanner here rather than
 * in a gate, and keep this file import-safe (no top-level work): several gates run on import.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MODULES, type ModuleDef } from "../../architecture/module-manifest";

/** Repo-relative migrations directory. */
export const MIGRATIONS_DIR = join("packages", "db", "migrations");

export interface WalkOptions {
  /** Directory names never descended into. */
  readonly skipDirs?: readonly string[];
  /** Keep this file? Receives its basename and the path as it will be returned. */
  readonly include?: (name: string, path: string) => boolean;
  /** Resolve `dir` against this directory when reading; returned paths stay relative to it. */
  readonly base?: string;
  /** Throw when `dir` itself cannot be read (default: treat it as empty). */
  readonly mustExist?: boolean;
}

/**
 * Every file under `dir`, depth-first in `readdirSync` order, as `join(dir, …)` paths. An unreadable
 * subdirectory is skipped; `statSync` follows symlinks.
 */
export function walkFiles(dir: string, options: WalkOptions = {}): string[] {
  const { skipDirs = [], include = () => true, base, mustExist = false } = options;
  const resolve = (path: string): string => (base === undefined ? path : join(base, path));
  const out: string[] = [];
  const visit = (current: string, isRoot: boolean): void => {
    let entries: string[];
    try {
      entries = readdirSync(resolve(current));
    } catch (err) {
      if (isRoot && mustExist) throw err;
      return;
    }
    for (const name of entries) {
      const path = join(current, name);
      if (statSync(resolve(path)).isDirectory()) {
        if (!skipDirs.includes(name)) visit(path, false);
      } else if (include(name, path)) {
        out.push(path);
      }
    }
  };
  visit(dir, true);
  return out;
}

const APP_SOURCE_ROOTS = ["apps", "packages"];
const APP_SOURCE_SKIP_DIRS = ["node_modules", "dist", "build", ".turbo", "coverage", "__tests__"];

/** Every non-test, non-declaration `.ts` file under `root`'s apps/ and packages/, as absolute paths. */
export function appSourceFiles(root: string): string[] {
  return APP_SOURCE_ROOTS.flatMap((dir) =>
    walkFiles(join(root, dir), {
      skipDirs: APP_SOURCE_SKIP_DIRS,
      include: (name) =>
        name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.includes(".test."),
    }),
  );
}

/** The `.sql` basenames in a migrations directory, sorted (= apply order). */
export function listMigrations(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

/**
 * `sql` with `--` line comments and block comments replaced by a space, so their prose never parses
 * as DDL. One left-to-right pass: whichever comment opens first wins, so `-- see /* x` does not start
 * a block and a `--` inside a block comment does not eat its closing `*\/`. String literals and nested
 * block comments are not tracked.
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " ");
}

export interface CreatedTable {
  /** The table name as written, double quotes removed (case preserved, schema dropped). */
  readonly name: string;
  /** `CREATE TABLE child PARTITION OF parent` — it inherits the parent's columns and indexes. */
  readonly isPartition: boolean;
  /** Offset of the first `(` after the name (the column list, for a plain table), or -1. */
  readonly open: number;
}

const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)`;

/** Every `CREATE TABLE [IF NOT EXISTS] [schema.]name` in `sql` (strip comments first if they matter). */
export function parseCreateTables(sql: string): CreatedTable[] {
  const createRe = new RegExp(
    String.raw`\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${IDENT}\.)?(${IDENT})`,
    "gi",
  );
  return [...sql.matchAll(createRe)].map((m) => {
    const after = (m.index ?? 0) + m[0].length;
    const open = sql.indexOf("(", after);
    const semi = sql.indexOf(";", after);
    // `PARTITION OF` counts only in the statement head — up to the first `(` or `;` — so a parent's
    // `PARTITION BY` followed by a later child's `PARTITION OF` cannot misclassify the parent.
    const headEnd = Math.min(open === -1 ? sql.length : open, semi === -1 ? sql.length : semi);
    return {
      name: (m[1] as string).replace(/^"(.*)"$/, "$1"),
      isPartition: /\bPARTITION\s+OF\b/i.test(sql.slice(after, headEnd)),
      open,
    };
  });
}

export interface PgTableDef {
  /** The exported Drizzle const. */
  readonly constName: string;
  /** The SQL table name (`pgTable`'s first argument). */
  readonly sqlName: string;
}

/** Every `export const x = pgTable("table", …)` in a Drizzle schema source. */
export function parsePgTables(src: string): PgTableDef[] {
  return [...src.matchAll(/export\s+const\s+(\w+)\s*=\s*pgTable\(\s*['"](\w+)['"]/g)].map((m) => ({
    constName: m[1] as string,
    sqlName: m[2] as string,
  }));
}

/** The module whose manifest `codePaths` own repo-relative `path` (the most specific prefix wins). */
export function moduleForPath(
  path: string,
  modules: readonly ModuleDef[] = MODULES,
): ModuleDef | undefined {
  let best: { mod: ModuleDef; length: number } | undefined;
  for (const mod of modules) {
    for (const prefix of mod.codePaths) {
      const owns = path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
      if (owns && (best === undefined || prefix.length > best.length))
        best = { mod, length: prefix.length };
    }
  }
  return best?.mod;
}
