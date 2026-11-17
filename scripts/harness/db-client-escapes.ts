/**
 * What a database client's own command language can do beyond SQL (ADV5-1, widened in wave 8, T3): `sqlite3 .shell`,
 * `psql \!`, `mysql system` and the like run an operating-system command from inside an ordinary client, and the
 * commands around them write or read files (`.output F`, `\o F`, `\copy t to F`, `tee F`, `.read F`, `\i F`, SQL such as
 * `writefile()`, `COPY … TO`). A text heuristic for a cooperative agent, not a sandbox: it reads the text the client is
 * handed (an argument, a here-string, a heredoc body, what an `echo`/`printf` pipes in), both as the guard lexed it and as
 * the client receives it once the shell has reduced the backslashes of a double-quoted word (`"\\o X"` is `\o X`).
 *
 * The readers: sqlite3, litecli and duckdb (`sqlite-commands.ts`), psql, pgcli, usql and `cockroach sql`
 * (`postgres-commands.ts`), mysql, mariadb and mycli (here), sqlcmd, sqlplus, mongosh, clickhouse-client and trino (here,
 * coarser), the SQL that names a file (`sql-file-functions.ts`), and the editors (`ed`, `ex`, `vi`, `vim`, `nvim`: every
 * name in a command text is a file they may write). Not read: a script file's CONTENTS (`psql -f F`, `sqlite3 db < F`),
 * a command assembled at run time (`psql -c "$CMD"`), a client this table does not name (`iredis`, `mssql-cli`,
 * `harlequin`, one reached through an alias), and a bound variable (`\set X …` then `\o :X`). Pure.
 */
import {
  type ClientFindings,
  LINE_BREAK,
  type Reading,
  bothReadings,
  readOf,
  shellOf,
  tokens,
  writeOf,
} from "./client-reading";
import { optionValues } from "./option-values";
import { postgresReading } from "./postgres-commands";
import { embeddedNames } from "./protected-operands";
import { sqlFileReadings } from "./sql-file-functions";
import { sqliteReading } from "./sqlite-commands";
import type { StdinFeed } from "./stdin-texts";

export type { ClientFindings } from "./client-reading";

type Kind = "sqlite" | "postgres" | "mysql" | "editor" | "sqlcmd" | "sqlplus" | "mongo" | "sql";

const CLIENTS: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  ["sqlite3", "sqlite"],
  ["litecli", "sqlite"],
  ["duckdb", "sqlite"],
  ["psql", "postgres"],
  ["pgcli", "postgres"],
  ["usql", "postgres"],
  ["cockroach", "postgres"],
  ["mysql", "mysql"],
  ["mariadb", "mysql"],
  ["mycli", "mysql"],
  ["sqlcmd", "sqlcmd"],
  ["sqlplus", "sqlplus"],
  ["mongosh", "mongo"],
  ["clickhouse-client", "sql"],
  ["clickhouse-local", "sql"],
  ["trino", "sql"],
  // An editor takes its commands as an argument, on standard input or in a here-document (`ed f <<< 'w F'`, `vim -c 'w! F'`):
  // every name in that text is a file it may write (wave 8, ADV6-2).
  ["ed", "editor"],
  ["ex", "editor"],
  ["vi", "editor"],
  ["vim", "editor"],
  ["nvim", "editor"],
]);

/** Is this program a client with a command language of its own? (`cockroach` only as `cockroach sql`: see {@link kindOf}.) */
export const isDbClient = (prog: string): boolean => CLIENTS.has(prog);

/** The reader for a program and its arguments: `cockroach` is a client only for its `sql` subcommand. */
function kindOf(prog: string, args: readonly string[]): Kind | undefined {
  if (prog === "cockroach" && args[0] !== "sql") return undefined;
  return CLIENTS.get(prog);
}

// ---------------------------------------------------------------------------------------------------------
// mysql, mariadb, mycli: client commands at the start of a statement
// ---------------------------------------------------------------------------------------------------------

const MYSQL_COMMAND = /(?:^|[\r\n;])[ \t]*(system|pager|tee|source|\\[!PT.])[ \t]*([^\r\n;]*)/gi;

function mysqlCommand(name: string, rest: string): Reading {
  const lower = name.toLowerCase();
  const file = tokens(rest)[0];
  if (lower === "system" || lower === "pager" || lower === "\\!" || lower === "\\p") {
    // A bare `pager` (or `\P`) resets the pager to the default.
    return lower.includes("p") && rest.trim() === "" ? {} : shellOf(lower);
  }
  if (lower === "tee" || lower === "\\t") return writeOf(file);
  return readOf(file); // `source F`, `\. F`
}

/** `--pager=cmd` runs a program and `--tee=F` writes a file, whatever the statement says. */
function mysqlOption(arg: string): Reading {
  const m = /^--(pager|tee)=(.+)$/s.exec(arg);
  if (!m) return {};
  return m[1] === "pager" ? shellOf("--pager") : writeOf(m[2]);
}

function mysqlReading(text: string): Reading[] {
  const commands = [...text.matchAll(MYSQL_COMMAND)].map((m) =>
    mysqlCommand(m[1] as string, (m[2] ?? "").trim()),
  );
  return [...commands, ...text.split(LINE_BREAK).map(mysqlOption), ...sqlFileReadings(text)];
}

// ---------------------------------------------------------------------------------------------------------
// sqlcmd, sqlplus, mongosh: coarser readers
// ---------------------------------------------------------------------------------------------------------

/** sqlcmd: `!!cmd` and `:!!cmd` run a program, `:out F` writes, `:r F` reads. */
function sqlcmdReading(text: string): Reading[] {
  const out: Reading[] = [];
  for (const line of text.split(LINE_BREAK)) {
    if (/^\s*:?!!/.test(line)) out.push(shellOf("!!"));
    const file = /^\s*:(out|o|r)\s+(\S+)/i.exec(line);
    if (file) out.push(/^r$/i.test(file[1] as string) ? readOf(file[2]) : writeOf(file[2]));
  }
  return [...out, ...sqlFileReadings(text)];
}

/** sqlplus: `host`, `ho`, `!` and `$` run a program; `spool`, `save`, `store set` write; `@`, `@@`, `start`, `get` read. */
function sqlplusReading(text: string): Reading[] {
  const out: Reading[] = [];
  for (const line of text.split(LINE_BREAK)) {
    if (/^\s*(?:host|ho|!|\$)(?:\s|$)/i.test(line)) out.push(shellOf("host"));
    const writes = /^\s*(?:spool|save|store\s+set)\s+(\S+)/i.exec(line)?.[1];
    if (writes !== undefined) out.push(writeOf(writes.replace(/[;.]$/, "")));
    const reads = /^\s*(?:@@?|start\s+|get\s+)\s*(\S+)/i.exec(line)?.[1];
    if (reads !== undefined) out.push(readOf(reads.replace(/;$/, "")));
  }
  return [...out, ...sqlFileReadings(text)];
}

const FILE_ARGUMENT = String.raw`\(\s*(['"])(.+?)\1`;

/** mongosh: `cat("F")` and `load("F")` read, `fs.writeFileSync("F")` writes, `child_process` runs a program. */
function mongoReading(text: string): Reading[] {
  const out: Reading[] = [];
  for (const m of text.matchAll(
    new RegExp(
      String.raw`\b(?:cat|load|readFileSync|readFile|createReadStream)\s*${FILE_ARGUMENT}`,
      "g",
    ),
  )) {
    out.push(readOf(m[2]));
  }
  for (const m of text.matchAll(
    new RegExp(
      String.raw`\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*${FILE_ARGUMENT}`,
      "g",
    ),
  )) {
    out.push(writeOf(m[2]));
  }
  if (/\bchild_process\b/.test(text)) out.push(shellOf("child_process"));
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The text a client is handed, and what it holds
// ---------------------------------------------------------------------------------------------------------

/**
 * Every text the client reads as commands: each argument and the value attached to it (`--command=…`, `-c…`), what it is fed on stdin
 * (`stdin-texts.ts`: a here-string, a heredoc body, a process substitution, what a command earlier in its pipeline prints or passes on, a
 * known variable), in the order its own, its arguments, then upstream. Returned as the text the guard lexed and, when it differs, the text the
 * client receives after the shell reduced the backslashes of a double-quoted word; each is one text (its parts on separate lines, in order)
 * so that `.cd` and `\cd` carry from one argument to the next.
 */
export function clientTexts(args: readonly string[], feed: StdinFeed): string[] {
  const parts: string[] = [...feed.own, ...feed.bodies];
  for (const arg of args) {
    parts.push(arg);
    const attached = /^--[A-Za-z][\w-]*=(.*)$/s.exec(arg) ?? /^-[A-Za-z](.+)$/s.exec(arg);
    if (attached) parts.push(attached[1] as string);
  }
  parts.push(...feed.upstream, ...feed.upstreamBodies);
  const readings = parts.map(bothReadings);
  const lexed = parts.join("\n");
  const received = readings.map((r) => r.at(-1) as string).join("\n");
  return received === lexed ? [lexed] : [lexed, received];
}

function readingsOf(kind: Kind, text: string): Reading[] {
  switch (kind) {
    case "sqlite":
      return sqliteReading(text);
    case "postgres":
      return postgresReading(text);
    case "mysql":
      return mysqlReading(text);
    case "sqlcmd":
      return sqlcmdReading(text);
    case "sqlplus":
      return sqlplusReading(text);
    case "mongo":
      return mongoReading(text);
    case "sql":
      return sqlFileReadings(text);
    case "editor":
      return embeddedNames([text], true).map((name) => writeOf(name));
  }
}

/** The files a client's own options name: a script it reads (`psql -f F`), a config (`--defaults-file`), an output (`sqlcmd -o F`). */
function optionReadings(kind: Kind, args: readonly string[]): Reading[] {
  const reads = (files: readonly string[]): Reading[] => files.map((f) => readOf(f));
  switch (kind) {
    case "postgres":
      return reads(optionValues(args, "f", [["file", 4]]));
    case "mysql":
      return reads(
        optionValues(args, "", [
          ["defaults-file", 8],
          ["defaults-extra-file", 8],
        ]),
      );
    case "sqlcmd":
      return [
        ...reads(optionValues(args, "i", [])),
        ...optionValues(args, "o", []).map((f) => writeOf(f)),
      ];
    case "sql":
      return reads(
        optionValues(args, "f", [
          ["file", 4],
          ["queries-file", 7],
        ]),
      );
    case "mongo":
      return reads(optionValues(args, "f", [["file", 4]]));
    case "sqlite":
      return reads(
        args.flatMap((a, k) => (a === "-init" && args[k + 1] ? [args[k + 1] as string] : [])),
      );
    default:
      return [];
  }
}

/** What `prog` does with the texts it is handed (and the options it is started with); null for a program that is not a client. */
export function clientFindings(
  prog: string,
  texts: readonly string[],
  args: readonly string[] = [],
): ClientFindings | null {
  const kind = kindOf(prog, args);
  if (kind === undefined) return null;
  const readings = [
    ...texts.flatMap((text) => readingsOf(kind, text)),
    ...optionReadings(kind, args),
  ];
  const collect = (pick: (r: Reading) => readonly string[] | undefined): string[] => [
    ...new Set(readings.flatMap((r) => pick(r) ?? [])),
  ];
  return {
    shell: collect((r) => r.shell),
    writes: collect((r) => r.writes),
    reads: collect((r) => r.reads),
  };
}
