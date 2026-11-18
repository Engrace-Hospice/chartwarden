/**
 * SQL that names a file, in any SQL client (wave 8, T3(c); round-6 ADV6-5, ADV6-6): sqlite's `readfile()`/`writefile()`,
 * `VACUUM INTO`, `ATTACH`; duckdb's `read_csv()`/`read_json()`/`read_text()`/`read_parquet()`, `COPY … TO|FROM`, `EXPORT
 * DATABASE`; postgres' `lo_import()`/`lo_export()`/`pg_read_file()`/`COPY … TO|FROM 'file'` and `COPY … PROGRAM`; mysql's
 * `INTO OUTFILE|DUMPFILE` and `LOAD_FILE()`; clickhouse's `file()`. A file the statement READS is refused when it is a secret;
 * one it WRITES is judged like a redirect target; a function that loads code or runs a program (`load_extension()`,
 * `edit()`, `xp_cmdshell`, `COPY … PROGRAM`, `LOAD 'x'`) asks. The file may be a string literal or a bound parameter
 * (`writefile(@f, …)` after `.parameter set @f 'X'`). Read as text: a name a statement builds at run time is unseen. Pure.
 */
import type { Reading } from "./client-reading";

/** Parameters bound by `.parameter set @name VALUE`, by the name as typed (`@f`, `:f`, `$f`). */
export type Parameters = ReadonlyMap<string, string>;

/** A string literal (`'x'` or `"x"`) or a parameter reference, as the first thing in an argument list. */
const FILE_ARGUMENT = String.raw`(?:(['"])(.+?)\1|([@:$][A-Za-z_]\w*))`;

const READ_FUNCTIONS = String.raw`readfile|read_(?:csv|json|ndjson|text|blob|parquet)(?:_auto)?|pg_read_(?:binary_)?file|lo_import|load_file|file`;

interface Pattern {
  readonly regex: RegExp;
  readonly kind: "read" | "write";
}

const pattern = (source: string, kind: Pattern["kind"]): Pattern => ({
  regex: new RegExp(source, "gis"),
  kind,
});

const PATTERNS: readonly Pattern[] = [
  pattern(String.raw`\b(?:${READ_FUNCTIONS})\s*\(\s*${FILE_ARGUMENT}`, "read"),
  pattern(String.raw`\bwritefile\s*\(\s*${FILE_ARGUMENT}`, "write"),
  pattern(String.raw`\blo_export\s*\(\s*[^,()]+,\s*${FILE_ARGUMENT}`, "write"),
  pattern(String.raw`\bcopy\b[^;]*?\bto\s+${FILE_ARGUMENT}`, "write"),
  pattern(String.raw`\bcopy\b[^;]*?\bfrom\s+${FILE_ARGUMENT}`, "read"),
  pattern(String.raw`\binto\s+(?:outfile|dumpfile)\s+${FILE_ARGUMENT}`, "write"),
  pattern(String.raw`\bexport\s+database\s+${FILE_ARGUMENT}`, "write"),
  pattern(String.raw`\bvacuum\s+(?:\w+\s+)?into\s+${FILE_ARGUMENT}`, "write"),
  pattern(String.raw`\battach\s+(?:database\s+)?${FILE_ARGUMENT}`, "write"),
];

/** A function or statement that loads code or runs a program. */
const SHELL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bload_extension\s*\(/i, "load_extension()"],
  [/\bedit\s*\(/i, "edit()"],
  [/\bxp_cmdshell\b/i, "xp_cmdshell"],
  [/\bcopy\b[^;]*?\bprogram\b/is, "COPY … PROGRAM"],
  [/(?:^|;)\s*load\s+(?:extension\s+)?['"]/im, "LOAD"],
];

/** The file an argument names: the literal, or the value its parameter was bound to. */
function fileOf(match: RegExpMatchArray, params: Parameters): string | undefined {
  const literal = match[2];
  if (literal !== undefined) return literal;
  const name = match[3];
  return name === undefined ? undefined : (params.get(name) ?? params.get(name.slice(1)));
}

/** Every reading of the SQL text: files read and written, programs run. */
export function sqlFileReadings(text: string, params: Parameters = new Map()): Reading[] {
  const out: Reading[] = [];
  for (const { regex, kind } of PATTERNS) {
    for (const match of text.matchAll(regex)) {
      const file = fileOf(match, params);
      if (file === undefined || file === "") continue;
      out.push(kind === "read" ? { reads: [file] } : { writes: [file] });
    }
  }
  for (const [regex, what] of SHELL_PATTERNS) if (regex.test(text)) out.push({ shell: [what] });
  return out;
}
