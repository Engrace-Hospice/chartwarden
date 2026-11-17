/**
 * Which database a client command connects to (wave 9, W9-1; rebuilt in wave 10, B1-B7). `.claude/rules/phi-and-secrets.md`:
 * an agent session does not connect to a non-local database host. ONE reader serves every client: an option table per
 * client (`db-target-clients.ts`), the URI and connection-string grammars of libpq (`db-uri.ts`), the shell variables a
 * command line sets (`db-variables.ts`), and the existing local-host predicate of `content-scan.ts`, unchanged. A target it
 * cannot read is a finding, not an allow. Pure; the words are the lexer's, with the backslashes the shell would remove still
 * in them (libpq removes backslashes of its own in a connection string, so the reader needs both).
 */
import { LOCAL_HOST } from "./content-scan";
import { containerHostKind } from "./db-container-hosts";
import { type Role, readLongOption, readShortOption } from "./db-long-options";
import { TARGET_CLIENTS, type TargetClient } from "./db-target-clients";
import { parseConninfo, uriReadings } from "./db-uri";
import {
  HAS_EXPANSION,
  expandVariables,
  holdsUnplacedFill,
  opaqueSubstitutions,
  valuesByName,
} from "./db-variables";

/**
 * - `remote`: a host that is not local; the command is refused.
 * - `unparsed`: a target string the reader cannot parse (an open quote, a word libpq would refuse); refused.
 * - `indirect`: the host lives in a service, a password file, a login path or a DSN alias the guard cannot read; a human decides.
 * - `variable`: `$DATABASE_URL`, `"$URL"` or `$(cat f)` in the place of a target could point anywhere; a human decides.
 * - `alias`: a bare container-network name (`db`, `mysql`, `mongo`) as the host a program is started with: it resolves on a compose
 *   network, and a resolver search domain could resolve it elsewhere; a human decides (`db-container-hosts.ts`).
 * - `option`: a long option the guard cannot place (an ambiguous or an unknown abbreviation of the client's own options), so it
 *   cannot tell whether the word names a host or takes the next word; a human decides.
 */
export interface DatabaseTarget {
  readonly kind: "remote" | "unparsed" | "indirect" | "variable" | "option" | "alias";
  /** The host, the string that did not parse or the name of the indirection. */
  readonly subject: string;
  /** Found in a program's words, not in a client's own options: a human decides instead of a refusal (`db-any-program.ts`). */
  readonly advisory?: boolean;
}

const URI = /^(?:jdbc:)?([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s;
const MAX_RECURSION = 3;
const DATABASE_URL_VARIABLE = /\$\{?[A-Z_]*DATABASE_URL/;
const ADDRESS_CHARACTER = /[.:/@]/;
const FILE_LIKE = /\.(?:js|mjs|cjs|mongodb|json|pem|crt|cer|key|conf|ya?ml|sql|txt)$/i;
/** A port, or a variable that holds one (`localhost:$PORT`): the part after the colon is not part of the host name. */
const PORT_SUFFIX = /:(?:\d+|\$\{?\w+\}?)$/;
const ADDRESS_PORT_WORD = /^[^\s/:@]+:\d+$/;

/** What one command line names. */
interface Found {
  hosts: string[];
  unparsed: string[];
  indirect: string[];
  variables: string[];
  options: string[];
  aliases: string[];
}

/** A command-line word: what the lexer kept (`raw`) and what the shell would pass on (`shell`: backslashes removed). */
interface Word {
  readonly raw: string;
  readonly shell: string;
}

/** What one reading of a command line works with. */
interface Reader {
  readonly spec: TargetClient;
  readonly found: Found;
  /** Every value the command's variable statements assign each name. */
  readonly vars: ReadonlyMap<string, readonly string[]>;
  /** A host that still holds a variable or a substitution is one a human decides (`db-any-program.ts`), not a refused host. */
  readonly unplacedIsVariable?: boolean;
}

/** What the shell does to a word before the program sees it: remove backslashes. */
const shellUnescape = (text: string): string => text.replace(/\\(.)/gs, "$1");
const wordOf = (raw: string): Word => ({ raw, shell: shellUnescape(raw) });

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** The hosts a host value lists, ports and brackets dropped: `a:5432`, `[::1]:5432`, `a,b`, `rs0/a:1,b`, `tcp:a,1433`. */
function hostsOf(value: string, spec: TargetClient): string[] {
  const text = value.replace(/^(?:tcp|np|lpc):/i, "");
  // `rs0/a,b` is a replica-set name in front of the list for MongoDB's tools; for every other client `a/b` is one name.
  const withoutReplicaSet =
    spec.replicaSet && !text.startsWith("/") ? text.replace(/^[^/,:]+\//, "") : text;
  const pieces = spec.commaIsPort
    ? [withoutReplicaSet.replace(/,\d+$/, "")]
    : withoutReplicaSet.split(",");
  return pieces.map(unwrapHost).filter((host) => host !== "");
}

/** `[::1]:5432` is `::1`; `host:5432` and `host:$PORT` are `host`; a bare IPv6 literal (two or more colons) stays whole. */
function unwrapHost(piece: string): string {
  const host = decode(piece.trim().split(";")[0] ?? "");
  const bracketed = /^\[([^\]]*)\](?::(?:\d+|\$\{?\w+\}?))?$/.exec(host);
  if (bracketed) return bracketed[1] ?? "";
  return (host.match(/:/g) ?? []).length > 1 ? host : host.replace(PORT_SUFFIX, "");
}

const addHosts = (r: Reader, value: string): void => {
  for (const host of hostsOf(value, r.spec)) {
    if (r.unplacedIsVariable && HAS_EXPANSION.test(host)) r.found.variables.push(host);
    else if (r.unplacedIsVariable && containerHostKind(host) === "generic")
      r.found.aliases.push(host);
    else if (!(r.unplacedIsVariable && containerHostKind(host) === "project"))
      r.found.hosts.push(host);
  }
};

/** `postgres://[userinfo@]host[:port][,host2]/db?host=...&service=...`, read as libpq reads it and as other URL parsers do. */
function readUri(text: string, r: Reader): void {
  // A fill-in the guard cannot place can supply the host (`localhost:$(echo 1@H)/db`, `?$(echo host=H)`): a human decides.
  if (holdsUnplacedFill(text, r.vars)) r.found.variables.push(text);
  const rest = URI.exec(opaqueSubstitutions(text))?.[2] ?? "";
  for (const { hostSection, query } of uriReadings(rest)) {
    if ((hostSection.match(/\[/g) ?? []).length !== (hostSection.match(/\]/g) ?? []).length) {
      r.found.unparsed.push(text);
      continue;
    }
    addHosts(r, hostSection);
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      const key = decode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
      const value = eq < 0 ? "" : decode(pair.slice(eq + 1));
      readKeyword(key, value, r, 0);
    }
  }
}

/** A libpq `key=value` pair: the host keywords, the indirections, and a `dbname` that is itself a connection string. */
function readKeyword(key: string, value: string, r: Reader, depth: number): void {
  if (key === "host" || key === "hostaddr") addHosts(r, value);
  else if ((key === "service" || key === "passfile") && value !== "")
    r.found.indirect.push(`${key}=${value}`);
  else if (key === "dbname" && depth < MAX_RECURSION) readTargetString(value, r, depth + 1);
  // The recursion cap ends in an ask (wave 12, F-1): a `dbname` that is itself a connection string past the cap is not read as a database name.
  else if (key === "dbname" && (URI.test(value) || value.includes("=")))
    r.found.variables.push(value);
}

/** A libpq connection string, read by libpq's own grammar. The hosts it names are recorded; true when libpq would accept it. */
function readConninfo(text: string, r: Reader, depth: number): boolean {
  if (holdsUnplacedFill(text, r.vars)) r.found.variables.push(text);
  const { pairs, error } = parseConninfo(text);
  for (const [key, value] of pairs) readKeyword(key, value, r, depth);
  // A string whose FIRST word has no `=` (`select 1 where a = 'b'`, handed to a shell function that is called `psql`) is
  // no attempt at a connection string: libpq refuses it and nothing connects. One that starts as one and goes wrong is refused.
  return error === undefined || (error === "missing-equals" && pairs.length === 0);
}

/** A text that is a connection string: a URI, a libpq string (a libpq client's text with `=`), or a bare address. */
function readTargetString(text: string, r: Reader, depth = 0): void {
  if (URI.test(text)) readUri(text, r);
  else if (r.spec.positional === "libpq" && text.includes("=")) {
    if (!readConninfo(text, r, depth)) r.found.unparsed.push(text);
  } else if (r.spec.bareStringIsHost && !HAS_EXPANSION.test(text)) addHosts(r, addressHost(text));
}

/** `user@host:port/db` is `host:port`. */
const addressHost = (word: string): string => word.replace(/[/?#].*$/s, "").replace(/^.*@/, "");

const conninfoShaped = (text: string, spec: TargetClient): boolean =>
  spec.positional === "libpq" && !URI.test(text) && text.includes("=");

/**
 * A word that is a libpq connection string and carries backslashes the shell kept (`'a\ b'`, single-quoted): the backslash
 * is libpq's to read, and the lexer cannot say whether the shell removed it (an unquoted word) or left it (a quoted one).
 * Only one reading is what the client receives, so the hosts of both are recorded. A string libpq would refuse is
 * `unparsed` (never "nothing found") when NO reading of it parses: the reading that parses is the connection the client
 * makes, and the one that does not is a connection it never makes.
 */
function readConninfoWord(word: Word, r: Reader): void {
  const accepted = [word.shell, word.raw].map((text) => readConninfo(text, r, 0));
  if (!accepted.some(Boolean)) r.found.unparsed.push(word.raw);
}

const hasBackslashReading = (word: Word, spec: TargetClient): boolean =>
  word.raw !== word.shell && conninfoShaped(word.raw, spec);

/**
 * A word that names a variable or a substitution where a target belongs and has no shape of its own (`"$URL"`,
 * `$(cat f)`): it could be any connection string, so a human decides. A URI or a connection string that merely holds a
 * variable (`localhost:$PORT`, `host=$H`) is read as written: a variable in its host is a host the guard refuses.
 */
const isUnplacedTarget = (
  expanded: { texts: readonly string[]; unplaceable: boolean },
  spec: TargetClient,
): boolean =>
  expanded.unplaceable &&
  expanded.texts.some(
    (text) => HAS_EXPANSION.test(text) && !URI.test(text) && !conninfoShaped(text, spec),
  );

/**
 * A word handed to the client as a connection string, with each variable it names replaced by every value a statement
 * assigns. `placeable` false: a word that still holds a variable the guard cannot place is a target a human decides.
 */
function readString(word: Word, r: Reader, placeable: boolean): void {
  if (hasBackslashReading(word, r.spec)) readConninfoWord(word, r);
  else {
    const expanded = expandVariables(word.shell, r.vars);
    for (const text of expanded.texts) readTargetString(text, r);
    if (placeable && isUnplacedTarget(expanded, r.spec)) r.found.variables.push(word.shell);
  }
}

/** A positional word, read as the client's grammar says. */
function readPositional(word: Word, index: number, r: Reader): void {
  const { spec } = r;
  if (hasBackslashReading(word, spec)) {
    readConninfoWord(word, r);
    return;
  }
  const expanded = expandVariables(word.shell, r.vars);
  for (const text of expanded.texts) {
    if (URI.test(text) || (spec.positional === "libpq" && text.includes("="))) {
      readTargetString(text, r);
    } else if (spec.positional === "host" && index === 0) {
      addHosts(r, text);
    } else if (
      spec.positional === "address" &&
      ADDRESS_CHARACTER.test(text) &&
      !FILE_LIKE.test(text)
    ) {
      addHosts(r, addressHost(text));
    }
  }
  if (index === 0 && spec.positionalVariable && isUnplacedTarget(expanded, spec)) {
    r.found.variables.push(word.shell);
  }
}

function takeValue(role: Role, value: Word, r: Reader, name: string): void {
  // `-h postgres://u@HOST/db` is not valid libpq, but it is what the agent means: read it as the URI it is.
  if (role === "host") {
    for (const text of expandVariables(value.shell, r.vars).texts) {
      if (URI.test(text)) readUri(text, r);
      else addHosts(r, text);
    }
  } else if (role === "string") readString(value, r, true);
  else if (role === "alias") {
    for (const text of expandVariables(value.shell, r.vars).texts) {
      if (URI.test(text)) readUri(text, r);
      else if (text !== "") r.found.indirect.push(`${name} ${text}`);
    }
  } else if (role === "indirect" && value.shell !== "")
    r.found.indirect.push(`${name}=${value.shell}`);
}

/**
 * What a long option of a command line is, with every abbreviation read as getopt_long reads it (`db-long-options.ts`). An
 * abbreviation the client's table cannot place asks, because the word may be the host option (`createdb --h=HOST`): an
 * ambiguous one always, an unknown one when the table is proven against the real program (the real program refuses it) or
 * when a bare word follows it (an unlisted option that may take that word as its value, which would hide it).
 */
const PRINTS_AND_EXITS: ReadonlySet<string> = new Set(["help", "version"]);

function placed(r: Reader, given: string, next: Word | undefined, attached: boolean): Role {
  const read = readLongOption(r.spec, given);
  if (read !== "ambiguous" && read !== "unknown") return read;
  // PostgreSQL's programs read `--help` and `--version` from `argv[1]`, not as options: they print and exit, nothing connects.
  if (read === "unknown" && PRINTS_AND_EXITS.has(given)) return "flag";
  const hidesWord = !attached && next !== undefined && !next.shell.startsWith("-");
  if (read === "ambiguous" || r.spec.verified === true || hidesWord)
    r.found.options.push(`--${given}`);
  return "flag";
}

const NO_WORD: Word = { raw: "", shell: "" };

/** The options, their values and the positional words of a command line, in one pass. */
function scan(r: Reader, words: readonly Word[]): Word[] {
  const positionals: Word[] = [];
  let literal = false;
  for (let k = 0; k < words.length; k++) {
    const word = words[k] as Word;
    const arg = word.shell;
    if (literal) positionals.push(word);
    else if (arg === "--") literal = true;
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const given = arg.slice(2, eq < 0 ? undefined : eq);
      const role = placed(r, given, words[k + 1], eq >= 0);
      if (role === "flag") continue;
      const value =
        eq >= 0
          ? { raw: word.raw.slice(word.raw.indexOf("=") + 1), shell: arg.slice(eq + 1) }
          : (words[++k] ?? NO_WORD);
      takeValue(role, value, r, `--${given}`);
    } else if (arg.startsWith("-") && arg.length > 1) {
      k = scanCluster(r, words, k);
    } else positionals.push(word);
  }
  return positionals;
}

/** `-Ath HOST`, `-hHOST`, `-dpostgres://HOST/x`: flag letters, then a letter that takes the rest of the word or the next word. */
function scanCluster(r: Reader, words: readonly Word[], at: number): number {
  const word = words[at] as Word;
  const arg = word.shell;
  for (let p = 1; p < arg.length; p++) {
    const role = readShortOption(r.spec, arg[p] as string);
    if (role === "flag") continue;
    if (role === "attached") return at;
    const rest = arg.slice(p + 1);
    // The raw rest is the same characters after the same prefix when no backslash came before the value.
    const rawRest = word.raw.slice(0, p + 1) === arg.slice(0, p + 1) ? word.raw.slice(p + 1) : rest;
    const next = rest === "" ? at + 1 : at;
    const value = rest === "" ? (words[next] ?? NO_WORD) : { raw: rawRest, shell: rest };
    takeValue(role, value, r, `-${arg[p]}`);
    return next;
  }
  return at;
}

/**
 * A host or connection-string option anywhere in the words, whatever the options before it were taken to consume (wave 10,
 * B4): a flag read as a value option, or a value option the table does not list, can no longer hide a later `-h HOST`.
 * Only the exact spellings (`-h`, `--host`, `--host=H`) and a following word that is not itself an option.
 */
function scanAnywhere(r: Reader, words: readonly Word[]): void {
  const { spec } = r;
  words.forEach((word, k) => {
    const arg = word.shell;
    const next = words[k + 1];
    const separate = next !== undefined && !next.shell.startsWith("-") ? next : undefined;
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      const given = arg.slice(2, eq < 0 ? undefined : eq);
      const role = readLongOption(spec, given);
      if (role !== "host" && role !== "string" && role !== "alias") return;
      const value = eq >= 0 ? wordOf(word.raw.slice(word.raw.indexOf("=") + 1)) : separate;
      if (value !== undefined) takeValue(role, value, r, `--${given}`);
    } else if (arg.length === 2 && arg.startsWith("-") && separate !== undefined) {
      const role = readShortOption(spec, arg[1] as string);
      if (role === "host" || role === "string" || role === "alias")
        takeValue(role, separate, r, arg);
    }
  });
}

/** The inline and exported environment: the host, a connection string, a service or a password file. */
function readEnvironment(r: Reader, assigns: readonly string[], inline: boolean): void {
  const { spec } = r;
  for (const assignment of assigns) {
    const eq = assignment.indexOf("=");
    const name = assignment.slice(0, eq);
    const value = shellUnescape(assignment.slice(eq + 1));
    const expanded = expandVariables(value, r.vars);
    if (spec.hostEnv.includes(name)) {
      for (const text of expanded.texts) {
        // An inline `PGHOST=$(…) psql` names a host the guard refuses; a variable some statement sets from a substitution is unplaced.
        if (!inline && HAS_EXPANSION.test(text)) r.found.variables.push(`${name}=${text}`);
        else addHosts(r, text);
      }
    } else if (spec.urlEnv?.includes(name)) {
      for (const text of expanded.texts) readTargetString(text, r);
    } else if (spec.indirectEnv.includes(name) && value !== "") r.found.indirect.push(assignment);
  }
}

/** The first non-local host among those found, if any. */
const firstRemote = (hosts: readonly string[]): string | undefined =>
  hosts.find((host) => !LOCAL_HOST.test(host));

/** The finding of a reading: the most severe thing it found, or null. */
function findingOf(found: Found, variable: string | undefined): DatabaseTarget | null {
  const remote = firstRemote(found.hosts);
  if (remote !== undefined) return { kind: "remote", subject: remote };
  if (found.unparsed[0] !== undefined) return { kind: "unparsed", subject: found.unparsed[0] };
  if (found.indirect[0] !== undefined) return { kind: "indirect", subject: found.indirect[0] };
  const unplaced = found.variables[0] ?? variable;
  if (unplaced !== undefined) return { kind: "variable", subject: unplaced };
  if (found.options[0] !== undefined) return { kind: "option", subject: found.options[0] };
  return found.aliases[0] === undefined ? null : { kind: "alias", subject: found.aliases[0] };
}

/**
 * The finding for a database client command, or null when it names nothing the guard must act on (a local target, no
 * target, or a program that is not a database client). `args` are the lexer's words (backslashes still in them); `assigns`
 * are the inline `NAME=value` words, `statements` the `NAME=value` words the command line's variable statements set (every
 * one of them, a rebound name too: `export PGHOST=localhost; export PGHOST=H; psql` reads both).
 */
export function databaseTarget(
  prog: string,
  args: readonly string[],
  assigns: readonly string[],
  statements: readonly string[] = [],
): DatabaseTarget | null {
  const spec = TARGET_CLIENTS.get(prog);
  if (spec === undefined) return null;
  const found: Found = {
    hosts: [],
    unparsed: [],
    indirect: [],
    variables: [],
    options: [],
    aliases: [],
  };
  const r: Reader = { spec, found, vars: valuesByName([...assigns, ...statements]) };
  const words = args.map(wordOf);
  const positionals = scan(r, words);
  positionals.forEach((word, index) => readPositional(word, index, r));
  scanAnywhere(r, words);
  if (spec.clusterWords && words.some((w) => w.shell === "--cluster")) {
    for (const word of positionals) if (ADDRESS_PORT_WORD.test(word.shell)) addHosts(r, word.shell);
  }
  readEnvironment(r, assigns, true);
  readEnvironment(r, statements, false);
  const database = args.find((word) => DATABASE_URL_VARIABLE.test(word));
  return findingOf(found, database);
}

/**
 * The finding for targets a client's own command language names (`\c host=H`, `dblink_connect('...')`, `connect("H")`;
 * `db-connect-commands.ts`): a `string` is a connection string (a URI, a libpq string, a bare address by the client's
 * grammar), a `host` is a host value.
 */
export function databaseTargetOfText(
  prog: string,
  targets: ReadonlyArray<readonly [text: string, role: "string" | "host"]>,
): DatabaseTarget | null {
  const spec = TARGET_CLIENTS.get(prog);
  if (spec === undefined) return null;
  const found: Found = {
    hosts: [],
    unparsed: [],
    indirect: [],
    variables: [],
    options: [],
    aliases: [],
  };
  const r: Reader = { spec, found, vars: new Map() };
  for (const [text, role] of targets) {
    if (role === "host") addHosts(r, text);
    else readTargetString(text, r);
  }
  return findingOf(found, undefined);
}

/** A client-neutral reader: URIs and host values of a program the table does not name (`db-any-program.ts`). */
const NEUTRAL: TargetClient = {
  valueShort: "",
  valueLong: [],
  hostLong: [],
  stringLong: [],
  positional: "uri",
  hostEnv: [],
  indirectEnv: [],
};

/**
 * The finding for database URIs and host values found in the words of any program (`db-any-program.ts`): each `uris` entry is
 * a `scheme://` URI (a remote host, a `?host=` or a `service=` in it is a finding), each `hosts` entry a host value.
 */
export function databaseTargetOfWords(
  uris: readonly string[],
  hosts: readonly string[],
  vars: ReadonlyMap<string, readonly string[]> = new Map(),
): DatabaseTarget | null {
  const found: Found = {
    hosts: [],
    unparsed: [],
    indirect: [],
    variables: [],
    options: [],
    aliases: [],
  };
  const r: Reader = { spec: NEUTRAL, found, vars, unplacedIsVariable: true };
  for (const uri of uris) for (const text of expandVariables(uri, vars).texts) readUri(text, r);
  for (const host of hosts) for (const text of expandVariables(host, vars).texts) addHosts(r, text);
  return findingOf(found, undefined);
}

/** The reason shown to the agent; `show` redacts a token (userinfo, length) as `patterns.ts` does for every reason. */
export function databaseTargetReason(
  finding: DatabaseTarget,
  show: (token: string) => string,
): string {
  const subject = show(finding.subject);
  switch (finding.kind) {
    case "remote":
      return `Connecting to database host \`${subject}\` from an agent session is access to PHI. Agents work against local or private-container databases with synthetic data only.`;
    case "unparsed":
      return `The database target \`${subject}\` cannot be read, so the guard cannot tell which host it connects to. Agents work against local or private-container databases with synthetic data only.`;
    case "indirect":
      return `\`${subject}\` names the database host in a service, password, login or DSN file the guard cannot read. Confirm it is a local or private-container database with synthetic data.`;
    case "option":
      return `\`${subject}\` is an option the guard cannot place for this database client (an ambiguous or unknown abbreviation), so it cannot tell whether it names the database host. Spell the option out, or confirm it is a local or private-container database with synthetic data.`;
    case "alias":
      return `\`${subject}\` is a bare container-network name: it resolves on a private compose network, and a resolver search domain could resolve it somewhere else. Confirm it is a local or private-container database with synthetic data.`;
    case "variable":
      return `\`${subject}\` could point anywhere (a variable or a substitution in the place of a database target). Confirm it is a local or private-container database with synthetic data.`;
  }
}
