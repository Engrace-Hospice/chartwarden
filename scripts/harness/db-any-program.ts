/**
 * A database target named for a program that is not a database client (wave 10, B8; round-7 R7-ADV-16). Wave 9 read the host of
 * the clients it knew; `DATABASE_URL=<remote> bun run db:migrate`, `... node x.js`, `... drizzle-kit push`, `... npx knex
 * migrate:latest` and `bun run db:migrate --url <remote>` reach a non-local database all the same, because the PROGRAM reads
 * the variable or the URL. Two readings, for every program that is not a client with a table of its own and is not one that only
 * prints or moves text:
 *
 * - a database variable set inline, by `export`, by a bare assignment or by `env X=v`: a host variable (`PGHOST`, `MYSQL_HOST`, ...)
 *   or a variable that holds a database URI (`DATABASE_URL`, `REDIS_URL`, `*_DATABASE_URL`, ...), with a non-local host in it. The
 *   variables that statements of the same command line set are expanded; a host that still holds a variable the guard cannot
 *   place asks. Read for a client with a table of its own too.
 * - a database URI (`postgres://`, `postgresql://`, `mysql://`, `mongodb://`, `mongodb+srv://`, `redis://`, `rediss://`,
 *   `clickhouse://`, `cockroachdb://`, `sqlserver://`, `cassandra://`, `jdbc:...`) that is a whole word or the value of one word
 *   (`--url=URI`, `-url=jdbc:...`, `-x url=URI`, `-e DATABASE_URL=URI`), with a non-local host in it. A URI in the middle of a
 *   longer word is text (a `sed` or `perl` program, a message) and is not read. A finding in the words is an ASK, not a refusal:
 *   the host may be a private container's network alias, and the word may be a placeholder.
 *
 * A program that cannot start another program (`echo`, `grep`, `cp`, an awk or sed or sort whose words are proven inert: `text-programs.ts`)
 * does not connect: a URI in its words is text, and a variable set for it is not read. A text tool that CAN run a command (`awk
 * 'BEGIN{system(...)}'`, `sed '1e ...'`, `vim -c '!...'`, `bat --pager`, a pager, `find -exec`, `git -c core.pager=`) keeps the rule
 * (wave 11, R8-ADV-6): the client it starts reads the variable. A tool run through a nested shell string is judged when that string is judged.
 * Pure.
 */
import { type DatabaseTarget, databaseTargetOfWords } from "./db-target";
import { TARGET_CLIENTS } from "./db-target-clients";
import { opaqueSubstitutions, valuesByName } from "./db-variables";
import { textProgramIsInert } from "./text-programs";

/** Variables that name the host of a database. */
const HOST_VARIABLE =
  /^(?:PGHOST|PGHOSTADDR|MYSQL_HOST|CLICKHOUSE_HOST|COCKROACH_HOST|SQLCMDSERVER|CQLSH_HOST|REDIS_HOST|MONGO_HOST|MONGODB_HOST|ETCDCTL_ENDPOINTS|INFLUX_HOST)$/;
const SCHEMES =
  "postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|rediss?|valkey|clickhouse|cockroachdb|sqlserver|cassandra";
/**
 * A database URI that is a whole word, or the value of an option or an assignment that is one word (`--url=URI`, `-url=jdbc:...`,
 * `DATABASE_URL=URI`, `url=URI`). A URI in the middle of a longer word is text: a `sed` or `perl` program, a message.
 */
const URI_WORD = new RegExp(`^(?:-{0,2}[\\w.-]+=)?((?:jdbc:)?(?:${SCHEMES}):\\/\\/\\S+)$`, "i");

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

/** The database URI a word is (or carries as its option or assignment value), with each command substitution made opaque. */
const uriOf = (word: string): string[] => {
  const uri = URI_WORD.exec(opaqueSubstitutions(word))?.[1];
  return uri === undefined ? [] : [uri];
};

/**
 * The finding for a program that can start another program, or null. The variables (`assigns`: inline `NAME=value`; `statements`: the
 * `NAME=value` words the command line's variable statements set) are read for every such program, a client with a table of its
 * own included (it may not know the variable); a refused host there is a refusal. The URIs in the WORDS only for a program that
 * is not a client with a table of its own, and a finding there is advisory (a human decides): the word may be a container's
 * network alias, a message, a placeholder. A host that holds a variable the guard cannot place is a decision for a human too.
 */
export function anyProgramTarget(
  prog: string,
  args: readonly string[],
  assigns: readonly string[],
  statements: readonly string[],
): DatabaseTarget | null {
  if (prog === "" || textProgramIsInert(prog, args)) return null;
  const variables = [...assigns, ...statements];
  const vars = valuesByName(variables);
  const hosts = variables.flatMap((word) => hostValue(word) ?? []);
  const fromVariables = databaseTargetOfWords([...new Set(variables.flatMap(uriOf))], hosts, vars);
  if (fromVariables !== null || TARGET_CLIENTS.has(prog)) return fromVariables;
  const fromWords = databaseTargetOfWords([...new Set(args.flatMap(uriOf))], [], vars);
  return fromWords === null ? null : { ...fromWords, advisory: true };
}
