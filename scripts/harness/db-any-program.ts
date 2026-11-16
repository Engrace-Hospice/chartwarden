import { type DatabaseTarget, databaseTargetOfWords } from "./db-target";
/**
 * A database target named for a program that is not a database client (wave 10, B8; round-7 R7-ADV-16). Wave 9 read the host of
 * the clients it knew; `DATABASE_URL=<remote> bun run db:migrate`, `... node x.js`, `... drizzle-kit push`, `... npx knex
 * migrate:latest` and `bun run db:migrate --url <remote>` reach a non-local database all the same, because the PROGRAM reads
 * the variable or the URL. Two readings, for every program that is not a client with a table of its own and is not one that only
 * prints or moves text:
 *
 * - a database variable (`PGHOST`, `MYSQL_HOST`, ... as a host; `DATABASE_URL`, `REDIS_URL`, `*_DATABASE_URL`, ... as a URI) set inline, by `export`, by a
 *   bare assignment or by `env X=v`, with a non-local host in it;
 * - a database URI (`postgres://`, `postgresql://`, `mysql://`, `mongodb://`, `mongodb+srv://`, `redis://`, `rediss://`,
 *   `clickhouse://`, `cockroachdb://`, `sqlserver://`, `cassandra://`, `jdbc:...`) anywhere in a word, `--url=URI`, `-url=jdbc:...`
 *   and `-x url=URI` included, with a non-local host in it.
 *
 * A program that only prints, searches or moves text (`echo`, `grep`, `git commit -m`, `cp`) does not connect: a URI in its words
 * is text, and a variable set for it is not read. A tool run through a nested shell string is judged when that string is judged.
 * Pure.
 */
import { TARGET_CLIENTS } from "./db-target-clients";

/** Programs that print, search, move or inspect text and files, and the builtins that set a variable: they connect to nothing. */
const TEXT_PROGRAMS =
  /^(?:echo|printf|cat|ls|cd|pwd|head|tail|wc|grep|egrep|fgrep|rg|ag|ack|sed|awk|gawk|cut|tr|sort|uniq|tee|test|\[|\[\[|true|false|:|which|type|command|date|sleep|mkdir|touch|rm|cp|mv|ln|chmod|chown|diff|jq|yq|git|gh|export|declare|typeset|readonly|local|unset|set|source|\.|alias|read|wait|exit|return|kill|basename|dirname|realpath|stat|file|find|xargs|less|more|bat|open|code|vim|vi|nano|emacs)$/;

/** Variables that name the host of a database. */
const HOST_VARIABLE =
  /^(?:PGHOST|PGHOSTADDR|MYSQL_HOST|CLICKHOUSE_HOST|COCKROACH_HOST|SQLCMDSERVER|CQLSH_HOST|REDIS_HOST|MONGO_HOST|MONGODB_HOST|ETCDCTL_ENDPOINTS|INFLUX_HOST)$/;
const SCHEMES =
  "postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|rediss?|valkey|clickhouse|cockroachdb|sqlserver|cassandra";
/** A database URI anywhere in a word (after a `=` or a space, or at its start; `jdbc:` allowed in front). */
const EMBEDDED_URI = new RegExp(`(?:^|[=\\s,;])((?:jdbc:)?(?:${SCHEMES}):\\/\\/\\S+)`, "gi");

/** The `NAME` and `value` of an assignment word. */
const split = (word: string): readonly [string, string] | null => {
  const eq = word.indexOf("=");
  return eq <= 0 ? null : [word.slice(0, eq).replace(/\+$/, ""), word.slice(eq + 1)];
};

/** The value of a `NAME=value` word that names a database host variable. */
function hostValue(word: string): string | null {
  const assignment = split(word);
  return assignment !== null && HOST_VARIABLE.test(assignment[0]) ? assignment[1] : null;
}

/** The database URIs in a word (`--url=URI`, `-url=jdbc:...`, `-x url=URI`, `NAME=URI`). */
const urisOf = (word: string): string[] =>
  [...word.matchAll(EMBEDDED_URI)].map((m) => m[1] as string);

/**
 * The finding for a program that is not a text tool, or null. The variables are read for every such program (a client with a
 * table reads its own too, and the same variable may be one it does not know); the URIs in the words only for a program that is
 * not a client with a table of its own, whose reader judges its options. `assigns` are the inline `NAME=value` words and
 * `statements` the `NAME=value` words the command line's variable statements set; `args` the lexer's words.
 */
export function anyProgramTarget(
  prog: string,
  args: readonly string[],
  assigns: readonly string[],
  statements: readonly string[],
): DatabaseTarget | null {
  if (prog === "" || TEXT_PROGRAMS.test(prog)) return null;
  const variables = [...assigns, ...statements];
  const words = TARGET_CLIENTS.has(prog) ? variables : [...variables, ...args];
  const hosts = variables.flatMap((word) => hostValue(word) ?? []);
  const uris = words.flatMap(urisOf);
  return databaseTargetOfWords([...new Set(uris)], hosts);
}
