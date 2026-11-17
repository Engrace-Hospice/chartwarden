/**
 * A database client that reconnects from inside its own command language (wave 10, B7; round-7 R7-ADV-9). The target of
 * `psql -c '\c host=H'`, of a here-string `psql <<< '\c H'`, of `echo '\connect postgres://H/db' | psql`, of a heredoc, is a
 * connection the options of the command line do not show: wave 9 read only the options and the environment. Read here:
 * psql, pgcli and usql `\c` / `\connect` (`\c {[DBNAME|- USER|- HOST|- PORT|-] | conninfo | URI}`, with a leading
 * `-reuse-previous=on|off`), a `dblink_connect('host=H ...')` literal and `CREATE SERVER ... OPTIONS (host 'H')` in SQL, the
 * mysql client's `connect DB HOST` and `\r DB HOST`, and mongosh's `connect("H")` / `Mongo("H")` / `new Mongo("H")`. A file the
 * agent wrote and then runs with `-f FILE` is a documented limit. `\c NAME` with one plain word is a database name (the same
 * host), except a word that looks like a host name (`prod.example.com`): it is read as a host too, a name with dots being the
 * likelier mistake. redis-cli reads its commands from stdin too: a `REPLICAOF`, `CLUSTER MEET`, `MIGRATE` or `FAILOVER TO` line makes the server it is
 * connected to open a connection out to a host (`db-target.ts`, `redisOutboundTarget`; wave 12, F-7).
 *
 * psql replaces `:name`, `:'name'` and `:"name"` in an argument of a backslash command by the variable's value (`psql -v c='host=H' -c '\c :c'`,
 * `\set c 'host=H'` first, `\gset`): the value is not in the text, so a connect command with such an argument asks (wave 12, F-7; R9-CR-9), whether
 * or not a binding is in the text (a `~/.psqlrc` binds too). So does a `dblink` call whose connection argument is one. Live psql could not be run
 * against a server here, so the reading follows the psql manual (\"Variables\" and \"Interpolation\"). Pure.
 */
import { LINE_BREAK, tokens } from "./client-reading";
import { type DatabaseTarget, databaseTargetOfText, redisOutboundTarget } from "./db-target";
import { metaCommands } from "./postgres-commands";

const POSTGRES_CLIENTS = /^(?:psql|pgcli|usql|cockroach)$/;
const MYSQL_CLIENTS = /^(?:mysql|mariadb|mycli)$/;
const MONGO_CLIENTS = /^(?:mongosh|mongo)$/;
const REDIS_CLIENTS = /^(?:redis-cli|valkey-cli)$/;

/** `\c`, `\conn`, `\connect`: psql reads the whole name; the shorter ones are read too (an unknown command connects nowhere). */
const CONNECT_NAME = /^c(?:o(?:n(?:n(?:e(?:c(?:t)?)?)?)?)?)?$/;
const CONNECTION_STRING = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/|=/;
const HOST_LIKE = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
/** `dblink('conn', 'sql')` names the connection first; `dblink_connect('name', 'conn')` names the connection first or second. */
const DBLINK_CALL =
  /\bdblink(_connect(?:_u)?)?\s*\(\s*'((?:[^']|'')*)'(?:\s*,\s*'((?:[^']|'')*)')?/gi;
const CONNECTION_LITERAL = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^[\w-]+\s*=/;
const SERVER_HOST = /\boptions\s*\([^)]*?\bhost(?:addr)?\s+'((?:[^']|'')*)'/gi;
const MYSQL_CONNECT = /(?:^|[\r\n;])[ \t]*(?:connect|\\r)[ \t]+([^\r\n;]*)/gi;
const MONGO_CONNECT = /\b(?:connect|Mongo)\s*\(\s*(['"])(.+?)\1/g;

type Target = readonly [text: string, role: "string" | "host"];

/** `:name`, `:'name'`, `:"name"` where psql interpolates (the colon starts the word or follows a character that is not part of a name or another colon). */
const COLON_VARIABLE = /(?:^|[^\w:]):(?:[A-Za-z_]\w*|'[A-Za-z_]\w*'|"[A-Za-z_]\w*")/;
/** A `dblink(…)` / `dblink_connect(…)` call with a colon variable among its arguments: the connection string is a variable's value. */
const DBLINK_VARIABLE =
  /\bdblink(?:_connect(?:_u)?)?\s*\([^)]*?(?<![\w:]):(?:[A-Za-z_]|['"][A-Za-z_])/i;

/** The first word of a connect command's arguments, or SQL's dblink call, that holds a psql variable reference. */
function variableReference(prog: string, text: string): string | undefined {
  if (!POSTGRES_CLIENTS.test(prog)) return undefined;
  for (const { name, rest } of metaCommands(text)) {
    if (!CONNECT_NAME.test(name)) continue;
    const word = tokens(rest).find((w) => COLON_VARIABLE.test(w));
    if (word !== undefined) return word;
  }
  return DBLINK_VARIABLE.exec(text)?.[0];
}

/** The targets one `\c` line names. */
function postgresConnect(rest: string): Target[] {
  const words = tokens(rest).filter((word) => !word.startsWith("-reuse-previous"));
  const strings = words.filter((word) => CONNECTION_STRING.test(word));
  if (strings.length > 0) return strings.map((word): Target => [word, "string"]);
  const host = words[2];
  const out: Target[] = host !== undefined && host !== "-" ? [[host, "host"]] : [];
  const database = words[0];
  if (database !== undefined && HOST_LIKE.test(database)) out.push([database, "host"]);
  return out;
}

/** The unescaped body of an SQL string literal. */
const literal = (text: string): string => text.replace(/''/g, "'");

function targetsOf(prog: string, text: string): Target[] {
  const out: Target[] = [];
  if (POSTGRES_CLIENTS.test(prog)) {
    for (const { name, rest } of metaCommands(text)) {
      if (CONNECT_NAME.test(name)) out.push(...postgresConnect(rest));
    }
    for (const m of text.matchAll(DBLINK_CALL)) {
      const literals = [m[2], ...(m[1] === undefined ? [] : [m[3]])].map((l) => literal(l ?? ""));
      for (const text of literals.filter((l) => CONNECTION_LITERAL.test(l)))
        out.push([text, "string"]);
    }
    for (const m of text.matchAll(SERVER_HOST)) out.push([literal(m[1] ?? ""), "host"]);
  } else if (MYSQL_CLIENTS.test(prog)) {
    for (const m of text.matchAll(MYSQL_CONNECT)) {
      const host = tokens(m[1] ?? "")[1];
      if (host !== undefined) out.push([host, "host"]);
    }
  } else if (MONGO_CLIENTS.test(prog)) {
    for (const m of text.matchAll(MONGO_CONNECT)) out.push([m[2] ?? "", "string"]);
  }
  return out;
}

/**
 * The finding for the connections a client's command texts open (the texts `clientTexts` returns: arguments, here-strings,
 * heredoc bodies, what an `echo` pipes in), or null when they open none the guard must act on.
 */
export function connectTargetOf(prog: string, texts: readonly string[]): DatabaseTarget | null {
  const targets = texts.flatMap((text) => targetsOf(prog, text));
  const found = targets.length === 0 ? null : databaseTargetOfText(prog, targets);
  if (found !== null && found.kind !== "alias") return found;
  const outbound = REDIS_CLIENTS.test(prog)
    ? texts
        .flatMap((text) => text.split(LINE_BREAK))
        .map((line) => redisOutboundTarget(tokens(line)))
        .find((target) => target !== null)
    : null;
  if (outbound !== null && outbound !== undefined) return outbound;
  const variable = texts.map((text) => variableReference(prog, text)).find((v) => v !== undefined);
  return variable === undefined ? found : { kind: "variable", subject: variable };
}
