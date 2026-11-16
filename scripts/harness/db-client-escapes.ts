/**
 * What a SQL client's own command language can do beyond SQL (ADV5-1): `sqlite3 .shell`/`.system`, `psql \!`,
 * `mysql system`, `pgcli \!` run an operating-system command from inside an ordinary database client, and the
 * dot-commands and backslash commands around them write or read files (`.output F`, `\o F`, `\copy t to F`, `tee F`,
 * `.read F`, `\i F`). A text heuristic for a cooperative agent, not a sandbox: it reads the text the client is
 * handed (an argument, a here-string, a heredoc body, what an `echo`/`printf` pipes in) and nothing else.
 *
 * Not read, and so not judged: a script file (`psql -f F`, `sqlite3 db < F`, `mysql < F`), a command assembled at
 * run time (`psql -c "$CMD"`), and SQL that makes the SERVER write a file (`COPY … TO PROGRAM`, `INTO OUTFILE`). Pure.
 */
import { printedText } from "./inline-code";
import { embeddedNames } from "./protected-operands";

/** What one client was handed to run, by what the guard should do about it. */
export interface ClientFindings {
  /** Escapes that run a program or load code; whatever they name, a human decides. */
  readonly shell: readonly string[];
  /** Files the client writes: judged like a redirect target. */
  readonly writes: readonly string[];
  /** Files the client reads and runs or prints: a secret one is refused. */
  readonly reads: readonly string[];
}

type Kind = "sqlite" | "postgres" | "mysql" | "editor";

const CLIENTS: ReadonlyMap<string, Kind> = new Map<string, Kind>([
  ["sqlite3", "sqlite"],
  ["psql", "postgres"],
  ["pgcli", "postgres"],
  ["mysql", "mysql"],
  ["mariadb", "mysql"],
  ["mycli", "mysql"],
  // An editor takes its commands as an argument, on standard input or in a here-document (`ed f <<< 'w F'`, `vim -c 'w! F'`):
  // every name in that text is a file it may write (wave 8, ADV6-2).
  ["ed", "editor"],
  ["ex", "editor"],
  ["vi", "editor"],
  ["vim", "editor"],
  ["nvim", "editor"],
]);

/** Is this program a SQL client with a command language of its own? */
export const isDbClient = (prog: string): boolean => CLIENTS.has(prog);

const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
const isOption = (t: string): boolean => t.startsWith("-");
const isPipe = (t: string): boolean => t.startsWith("|");
/** A target that names the terminal or switches logging off, not a file. */
const NOT_A_FILE = new Set(["stdout", "stderr", "off", "-", ":memory:"]);

/** A word the client reads as one token: surrounding quotes removed (`'/tmp/a b.csv'`). */
const unquote = (t: string): string => t.replace(/^(['"])(.*)\1$/s, "$2");

/** The blank-separated tokens of an argument line, a quoted token kept whole. */
function tokens(rest: string): string[] {
  return (rest.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(unquote);
}

/** One reading of a command line: what it runs, writes and reads. */
type Reading = Partial<ClientFindings>;

const shellOf = (what: string): Reading => ({ shell: [what] });
const writeOf = (file: string | undefined): Reading =>
  file === undefined || file === "" || NOT_A_FILE.has(file) ? {} : { writes: [file] };
const readOf = (file: string | undefined): Reading =>
  file === undefined || file === "" ? {} : { reads: [file] };

/** Does this word name `command`, as the shell accepts it: a prefix of at least `min` letters? */
const names = (word: string, command: string, min: number): boolean =>
  word.length >= min && command.startsWith(word);

// ---------------------------------------------------------------------------------------------------------
// sqlite3: dot-commands at the start of a line (abbreviated to a prefix, as its shell accepts), and SQL functions
// ---------------------------------------------------------------------------------------------------------

/** A dot-command that runs a program or loads code. Prefix lengths are the shortest the shell resolves. */
const SQLITE_SHELL: ReadonlyArray<readonly [string, number]> = [
  ["shell", 3],
  ["system", 3],
  ["load", 3],
  ["excel", 3],
  ["www", 3],
];

/** `.output`/`.once` and the rest: [name, shortest prefix, which operand is the file]. */
const SQLITE_FILE: ReadonlyArray<readonly [string, number, "first" | "last"]> = [
  ["output", 2, "first"],
  ["once", 2, "first"],
  ["backup", 3, "last"],
  ["save", 3, "first"],
  ["clone", 3, "first"],
  ["log", 2, "first"],
  ["trace", 3, "first"],
  ["open", 2, "first"],
];

function sqliteDot(name: string, rest: string): Reading {
  const lower = name.toLowerCase();
  const args = tokens(rest);
  const operands = args.filter((t) => !isOption(t));
  if (SQLITE_SHELL.some(([command, min]) => names(lower, command, min)))
    return shellOf(`.${lower}`);
  // `.output |cmd`, `.once |cmd`, `.import |cmd t`, `.read |cmd`: a pipe makes the file a command; `.once -e`
  // and `-x` open an editor or a spreadsheet.
  const sink = names(lower, "output", 2) || names(lower, "once", 2);
  const pipes = sink || names(lower, "import", 3) || names(lower, "read", 3);
  if (pipes && args.some(isPipe)) return shellOf(`.${lower} |`);
  if (sink && args.some((t) => t === "-e" || t === "-x")) return shellOf(`.${lower} -e`);
  const file = SQLITE_FILE.find(([command, min]) => names(lower, command, min));
  if (file) return writeOf(file[2] === "last" ? operands.at(-1) : operands[0]);
  if (names(lower, "import", 3) || names(lower, "read", 3)) return readOf(operands[0]);
  return {};
}

const SQLITE_SQL_WRITES: readonly RegExp[] = [
  /\bwritefile\s*\(\s*(['"])(.+?)\1/gis,
  /\bvacuum\s+(?:\w+\s+)?into\s+(['"])(.+?)\1/gis,
  /\battach\s+(?:database\s+)?(['"])(.+?)\1/gis,
];

function sqliteReading(text: string): Reading[] {
  const out: Reading[] = [];
  for (const line of text.split(LINE_BREAK)) {
    const dot = /^\s*\.([A-Za-z]+)(?:\s+(.*))?$/s.exec(line);
    if (dot) out.push(sqliteDot(dot[1] as string, dot[2] ?? ""));
  }
  for (const pattern of SQLITE_SQL_WRITES) {
    for (const m of text.matchAll(pattern)) out.push(writeOf(m[2]));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// psql and pgcli: backslash commands
// ---------------------------------------------------------------------------------------------------------

/**
 * A backslash command starts a line, follows a `;` or the `\\` separator, or is `\!`, `\g` or `\gx` (psql reads
 * those after SQL on the same line). Not any backslash: `'\w+'` inside a quoted regular expression is SQL, not `\w`.
 */
const PG_COMMAND = /(?:^|[\r\n;]|\\\\)[ \t]*\\([A-Za-z_]+|!)(?:[ \t]+([^\r\n]*)|(?=[\r\n]|$))/g;
const PG_ANYWHERE = /\\(!|gx?(?![A-Za-z_]))[ \t]*([^\r\n]*)/g;

function postgresCommand(name: string, rest: string): Reading {
  const args = tokens(rest);
  const first = args[0];
  if (name === "!" || name === "setenv" || name === "pager") return shellOf(`\\${name}`);
  if (/^(?:o|g|gx|w|write)$/.test(name)) {
    if (first !== undefined && isPipe(first)) return shellOf(`\\${name} |`);
    return first?.startsWith("(") ? {} : writeOf(first);
  }
  if (name === "copy") return postgresCopy(rest);
  if (name === "lo_export") return writeOf(args[1]);
  if (/^(?:i|ir|include|include_relative|lo_import)$/.test(name)) return readOf(first);
  return {};
}

/** `\copy t to 'F'` writes F, `\copy t from 'F'` reads it, and `program 'cmd'` runs a command. */
function postgresCopy(rest: string): Reading {
  if (/\bprogram\b/i.test(rest)) return shellOf("\\copy … program");
  const m = /\b(to|from)\s+(?:'((?:[^']|'')*)'|(\S+))/i.exec(rest);
  if (!m) return {};
  const file = (m[2] ?? m[3])?.replace(/''/g, "'");
  const reads = (m[1] as string).toLowerCase() === "from";
  if (file === undefined || /^(?:stdin|stdout|pstdin|pstdout)$/i.test(file)) return {};
  return reads ? readOf(file) : writeOf(file);
}

function postgresReading(text: string): Reading[] {
  return [...text.matchAll(PG_ANYWHERE), ...text.matchAll(PG_COMMAND)].map((m) =>
    postgresCommand(m[1] as string, m[2] ?? ""),
  );
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

function mysqlReading(text: string): Reading[] {
  return [...text.matchAll(MYSQL_COMMAND)].map((m) =>
    mysqlCommand(m[1] as string, (m[2] ?? "").trim()),
  );
}

/** `--pager=cmd` runs a program and `--tee=F` writes a file, whatever the statement says. */
function mysqlOption(arg: string): Reading {
  const m = /^--(pager|tee)=(.+)$/s.exec(arg);
  if (!m) return {};
  return m[1] === "pager" ? shellOf("--pager") : writeOf(m[2]);
}

// ---------------------------------------------------------------------------------------------------------
// The text a client is handed, and what it holds
// ---------------------------------------------------------------------------------------------------------

/** One simple command of a line, as far as this module needs it. */
export interface ClientStage {
  readonly prog: string;
  readonly args: readonly string[];
  /** Here-string words (`<<< 'text'`). */
  readonly strings: readonly string[];
  /** The operator that joined it to the command before it. */
  readonly joiner: string;
}

/**
 * Every text the client at `stages[index]` reads as commands: each argument and the value attached to it
 * (`--command=…`, `-c…`), a here-string, the heredoc bodies of this command, and what an `echo` or `printf` earlier
 * in its pipeline prints.
 */
export function clientTexts(
  stages: readonly ClientStage[],
  index: number,
  bodies: readonly string[],
): string[] {
  const client = stages[index] as ClientStage;
  const texts: string[] = [...client.strings, ...bodies];
  for (const arg of client.args) {
    texts.push(arg);
    const attached = /^--[A-Za-z][\w-]*=(.*)$/s.exec(arg) ?? /^-[A-Za-z](.+)$/s.exec(arg);
    if (attached) texts.push(attached[1] as string);
  }
  for (let j = index; stages[j]?.joiner === "|"; j--) {
    const source = stages[j - 1] as ClientStage;
    const printed = printedText(source.prog, source.args);
    if (printed !== null) texts.push(printed);
  }
  return texts;
}

/** What `prog` does with the texts it is handed; null for a program that is not a SQL client. */
export function clientFindings(prog: string, texts: readonly string[]): ClientFindings | null {
  const kind = CLIENTS.get(prog);
  if (kind === undefined) return null;
  const readings = texts.flatMap((text): Reading[] => {
    if (kind === "sqlite") return sqliteReading(text);
    if (kind === "postgres") return postgresReading(text);
    if (kind === "editor") return embeddedNames([text], true).map((name) => writeOf(name));
    return [...mysqlReading(text), mysqlOption(text)];
  });
  const collect = (pick: (r: Reading) => readonly string[] | undefined): string[] => [
    ...new Set(readings.flatMap((r) => pick(r) ?? [])),
  ];
  return {
    shell: collect((r) => r.shell),
    writes: collect((r) => r.writes),
    reads: collect((r) => r.reads),
  };
}
