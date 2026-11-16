/**
 * Which database a client command connects to (wave 9, W9-1). `.claude/rules/phi-and-secrets.md`: an agent session does
 * not connect to a non-local database host. The old rule read `-h HOST`, `--host=HOST`, a postgres URL WITH userinfo and
 * `PGHOST=` for four programs; a URL without userinfo, a libpq connection string (`host=HOST dbname=db`), a `-d` or
 * `--dbname` URI and every other client were allowed. This is ONE reader for them all: an option table per client
 * (`db-target-clients.ts`), a URI reader (no userinfo needed, a port, IPv6 literals, percent-encoding, `host=a,b` lists,
 * `?host=` parameters), a libpq connection-string reader that handles quoting, and the existing local-host predicate of
 * `content-scan.ts`, unchanged. A target it cannot read is a finding, not an allow. Pure; the words are already lexed
 * and unescaped.
 */
import { LOCAL_HOST } from "./content-scan";
import { TARGET_CLIENTS, type TargetClient } from "./db-target-clients";

/**
 * - `remote`: a host that is not local; the command is refused.
 * - `unparsed`: a target string the reader cannot parse (an open quote, an open bracket); refused.
 * - `indirect`: the host lives in a service, a password file, a login path or a DSN alias the guard cannot read; a human decides.
 * - `variable`: `$DATABASE_URL` could point anywhere; a human decides.
 */
export interface DatabaseTarget {
  readonly kind: "remote" | "unparsed" | "indirect" | "variable";
  /** The host, the string that did not parse or the name of the indirection. */
  readonly subject: string;
}

const URI = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/s;
const MAX_RECURSION = 3;
const PORT_SUFFIX = /:\d+$/;
const DATABASE_URL_VARIABLE = /\$\{?[A-Z_]*DATABASE_URL/;
const ADDRESS_CHARACTER = /[.:/@]/;
const FILE_LIKE = /\.(?:js|mjs|cjs|mongodb|json|pem|crt|cer|key|conf|ya?ml|sql|txt)$/i;
const ADDRESS_PORT_WORD = /^[^\s/:@]+:\d+$/;

/** What one command line names. */
interface Found {
  hosts: string[];
  unparsed: string[];
  indirect: string[];
}

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
  const withoutReplicaSet = text.startsWith("/") ? text : text.replace(/^[^/,:]+\//, "");
  const pieces = spec.commaIsPort
    ? [withoutReplicaSet.replace(/,\d+$/, "")]
    : withoutReplicaSet.split(",");
  return pieces.map(unwrapHost).filter((host) => host !== "");
}

/** `[::1]:5432` is `::1`; `host:5432` is `host`; a bare IPv6 literal (two or more colons) stays whole. */
function unwrapHost(piece: string): string {
  const host = decode(piece.trim());
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(host);
  if (bracketed) return bracketed[1] ?? "";
  return (host.match(/:/g) ?? []).length > 1 ? host : host.replace(PORT_SUFFIX, "");
}

const addHosts = (found: Found, value: string, spec: TargetClient): void => {
  found.hosts.push(...hostsOf(value, spec));
};

/** `postgres://[user[:pw]@]host[:port][,host2]/db?host=...&service=...`: the authority, then the query parameters. */
function readUri(text: string, spec: TargetClient, found: Found): void {
  const rest = URI.exec(text)?.[2] ?? "";
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  if ((hostPart.match(/\[/g) ?? []).length !== (hostPart.match(/\]/g) ?? []).length) {
    found.unparsed.push(text);
    return;
  }
  // Commas inside brackets do not occur in an address; split the list as written.
  addHosts(found, hostPart, spec);
  const query =
    authorityEnd < 0 ? "" : (rest.slice(authorityEnd).split("#")[0]?.split("?")[1] ?? "");
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    const key = decode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? "" : decode(pair.slice(eq + 1));
    readKeyword(key, value, spec, found, 0);
  }
}

/** A libpq `key=value` pair: the host keywords, the indirections, and a `dbname` that is itself a connection string. */
function readKeyword(
  key: string,
  value: string,
  spec: TargetClient,
  found: Found,
  depth: number,
): void {
  if (key === "host" || key === "hostaddr") addHosts(found, value, spec);
  else if ((key === "service" || key === "passfile") && value !== "")
    found.indirect.push(`${key}=${value}`);
  else if (key === "dbname" && depth < MAX_RECURSION)
    readTargetString(value, spec, found, depth + 1);
}

/** A libpq connection string: `key = value` pairs, a value quoted with `'` (backslash escapes) or ended by a space. */
function readConninfo(text: string, spec: TargetClient, found: Found, depth: number): void {
  const n = text.length;
  let i = 0;
  const skipSpace = (): void => {
    while (i < n && /\s/.test(text[i] as string)) i++;
  };
  while (i < n) {
    skipSpace();
    const start = i;
    while (i < n && !/[\s=]/.test(text[i] as string)) i++;
    const key = text.slice(start, i).toLowerCase();
    skipSpace();
    // A word with no `=` is not a connection string libpq accepts: no connection is made.
    if (text[i] !== "=") return;
    i++;
    skipSpace();
    let value = "";
    if (text[i] === "'") {
      i++;
      while (i < n && text[i] !== "'") {
        if (text[i] === "\\") i++;
        value += text[i] ?? "";
        i++;
      }
      if (i >= n) {
        found.unparsed.push(text);
        return;
      }
      i++;
    } else {
      while (i < n && !/\s/.test(text[i] as string)) {
        if (text[i] === "\\") i++;
        value += text[i] ?? "";
        i++;
      }
    }
    readKeyword(key, value, spec, found, depth);
  }
}

/** A word that is a connection string: a URI, a libpq string (a libpq client's word with `=`), or a bare address. */
function readTargetString(text: string, spec: TargetClient, found: Found, depth = 0): void {
  if (URI.test(text)) readUri(text, spec, found);
  else if (spec.positional === "libpq" && text.includes("="))
    readConninfo(text, spec, found, depth);
  else if (spec.bareStringIsHost) addHosts(found, addressHost(text), spec);
}

/** `user@host:port/db` is `host:port`. */
const addressHost = (word: string): string => word.replace(/[/?#].*$/s, "").replace(/^.*@/, "");

/** A positional word, read as the client's grammar says. */
function readPositional(word: string, index: number, spec: TargetClient, found: Found): void {
  if (URI.test(word) || (spec.positional === "libpq" && word.includes("="))) {
    readTargetString(word, spec, found);
  } else if (spec.positional === "host" && index === 0) {
    addHosts(found, word, spec);
  } else if (
    spec.positional === "address" &&
    ADDRESS_CHARACTER.test(word) &&
    !FILE_LIKE.test(word)
  ) {
    addHosts(found, addressHost(word), spec);
  }
}

type Role = "host" | "string" | "alias" | "indirect" | "value" | "flag";

/** A long option is its name or an unambiguous prefix of two characters or more (three for a plain value option). */
const named = (names: readonly string[] | undefined, given: string, minimum: number): boolean =>
  (names ?? []).some(
    (name) => given === name || (given.length >= minimum && name.startsWith(given)),
  );

function longRole(spec: TargetClient, given: string): Role {
  if (named(spec.hostLong, given, 2)) return "host";
  if (named(spec.stringLong, given, 2)) return "string";
  if (named(spec.aliasLong, given, 2)) return "alias";
  if (named(spec.indirectLong, given, 3)) return "indirect";
  return named(spec.valueLong, given, 3) ? "value" : "flag";
}

function shortRole(spec: TargetClient, letter: string): Role | "attached" {
  if (spec.hostShort?.includes(letter)) return "host";
  if (spec.stringShort?.includes(letter)) return "string";
  if (spec.aliasShort?.includes(letter)) return "alias";
  if (spec.attachedShort?.includes(letter)) return "attached";
  return spec.valueShort.includes(letter) ? "value" : "flag";
}

function takeValue(
  role: Role,
  value: string,
  spec: TargetClient,
  found: Found,
  name: string,
): void {
  // `-h postgres://u@HOST/db` is not valid libpq, but it is what the agent means: read it as the URI it is.
  if (role === "host") {
    if (URI.test(value)) readUri(value, spec, found);
    else addHosts(found, value, spec);
  } else if (role === "string") readTargetString(value, spec, found);
  else if (role === "alias") {
    if (URI.test(value)) readUri(value, spec, found);
    else if (value !== "") found.indirect.push(`${name} ${value}`);
  } else if (role === "indirect" && value !== "") found.indirect.push(`${name}=${value}`);
}

/** The options, their values and the positional words of a command line, in one pass. */
function scan(spec: TargetClient, args: readonly string[], found: Found): string[] {
  const positionals: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const arg = args[k] ?? "";
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const given = arg.slice(2, eq < 0 ? undefined : eq);
      const role = longRole(spec, given);
      if (role === "flag") continue;
      takeValue(role, eq < 0 ? (args[++k] ?? "") : arg.slice(eq + 1), spec, found, `--${given}`);
    } else if (arg.startsWith("-") && arg.length > 1) {
      k = scanCluster(spec, args, k, found);
    } else positionals.push(arg);
  }
  return positionals;
}

/** `-Ath HOST`, `-hHOST`, `-dpostgres://HOST/x`: flag letters, then a letter that takes the rest of the word or the next word. */
function scanCluster(
  spec: TargetClient,
  args: readonly string[],
  at: number,
  found: Found,
): number {
  const arg = args[at] ?? "";
  for (let p = 1; p < arg.length; p++) {
    const role = shortRole(spec, arg[p] as string);
    if (role === "flag") continue;
    if (role === "attached") return at;
    const rest = arg.slice(p + 1);
    const next = rest === "" ? at + 1 : at;
    takeValue(role, rest === "" ? (args[next] ?? "") : rest, spec, found, `-${arg[p]}`);
    return next;
  }
  return at;
}

/** The inline environment of the command: the host, a connection string, a service or a password file. */
function readEnvironment(spec: TargetClient, assigns: readonly string[], found: Found): void {
  for (const assignment of assigns) {
    const eq = assignment.indexOf("=");
    const name = assignment.slice(0, eq);
    const value = assignment.slice(eq + 1);
    if (spec.hostEnv.includes(name)) addHosts(found, value, spec);
    else if (spec.urlEnv?.includes(name)) readTargetString(value, spec, found);
    else if (spec.indirectEnv.includes(name) && value !== "") found.indirect.push(assignment);
  }
}

/** The first non-local host among those found, if any. */
const firstRemote = (hosts: readonly string[]): string | undefined =>
  hosts.find((host) => !LOCAL_HOST.test(host));

/**
 * The finding for a database client command, or null when it names nothing the guard must act on (a local target, no
 * target, or a program that is not a database client). `args` are unescaped words, `assigns` the inline `NAME=value` words.
 */
export function databaseTarget(
  prog: string,
  args: readonly string[],
  assigns: readonly string[],
): DatabaseTarget | null {
  const spec = TARGET_CLIENTS.get(prog);
  if (spec === undefined) return null;
  const found: Found = { hosts: [], unparsed: [], indirect: [] };
  const positionals = scan(spec, args, found);
  positionals.forEach((word, index) => readPositional(word, index, spec, found));
  if (spec.clusterWords && args.includes("--cluster")) {
    for (const word of positionals) if (ADDRESS_PORT_WORD.test(word)) addHosts(found, word, spec);
  }
  readEnvironment(spec, assigns, found);
  const remote = firstRemote(found.hosts);
  if (remote !== undefined) return { kind: "remote", subject: remote };
  if (found.unparsed[0] !== undefined) return { kind: "unparsed", subject: found.unparsed[0] };
  if (found.indirect[0] !== undefined) return { kind: "indirect", subject: found.indirect[0] };
  const variable = args.find((word) => DATABASE_URL_VARIABLE.test(word));
  return variable === undefined ? null : { kind: "variable", subject: variable };
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
    case "variable":
      return "`$DATABASE_URL` could point anywhere. Confirm it is a local or private-container database with synthetic data.";
  }
}
