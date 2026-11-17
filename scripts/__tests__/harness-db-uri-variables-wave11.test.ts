/**
 * Wave 11, part D, D1 (round-8 R8-CR-1, a wave-10 deny to allow regression): a variable or a substitution the guard cannot place,
 * inside a URI or a connection string whose host is local, hides a non-local host. In libpq's grammar, and in Redis's and MongoDB's,
 * a port position that holds `1@HOST` is userinfo followed by the real host, and a substitution may supply `@host/`, `?host=H` or
 * `&host=H` in the userinfo, the path or the query. Wave 10 read `localhost:$PORT` as host `localhost` whatever `$PORT` was, and made
 * every `$(...)` inert. Now a URI or connection string that holds a command substitution, or a reference to a name some statement
 * of the same text binds to something unplaceable (`read`, `printf -v`, `for`, `NAME=$(...)`, `mapfile`, `declare`), ASKS. Kept as
 * allow: a literal expansion (`PORT=5433; psql "...:$PORT/db"`, `export PORT=...`) and a plain unbound `$PORT`. Every remote name is
 * built from parts: the repo guard refuses a command that names a non-local database host.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example${"."}com`;
const PG = `post${"gres"}://`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string =>
  template
    .replaceAll("{H}", H)
    .replaceAll("{PG}", PG)
    .replaceAll("{R}", "redis://")
    .replaceAll("{M}", `mongo${"db"}://`);

/** Each is a command that connects to a non-local host (or may) through something the guard cannot place: never an allow. */
const UNPLACEABLE: ReadonlyArray<readonly [string, string]> = [
  ["read binds the port", "read PORT <<< '1@{H}'; psql \"{PG}localhost:$PORT/db\" -c 'select 1'"],
  ["printf -v binds the port", "printf -v PORT '%s' '1@{H}'; psql \"{PG}localhost:$PORT/db\""],
  ["for binds the port", "for PORT in '1@{H}'; do psql \"{PG}localhost:$PORT/db\"; done"],
  [
    "a substitution binds the port",
    "PORT=$(echo 1@{H}); psql \"{PG}localhost:$PORT/db\" -c 'select 1'",
  ],
  ["backticks bind the port", 'PORT=`echo 1@{H}`; psql "{PG}localhost:$PORT/db"'],
  ["mapfile binds the port", "mapfile -t PORT <<< '1@{H}'; psql \"{PG}localhost:${PORT}/db\""],
  ["declare binds the port", 'declare PORT=$(echo 1@{H}); psql "{PG}localhost:$PORT/db"'],
  ["export binds the port", 'export PORT=$(echo 1@{H}); psql "{PG}localhost:$PORT/db"'],
  ["a substitution in the port", "psql \"{PG}localhost:$(echo 1@{H})/db\" -c 'select 1'"],
  ["a substitution in the path", "psql \"{PG}localhost/$(echo 'db?host={H}')\""],
  ["a substitution in the query", "psql \"{PG}localhost/db?sslmode=$(echo 'require&host={H}')\""],
  ["a substitution after the path", "psql \"{PG}localhost/db$(echo '?host={H}')\""],
  ["a substitution that is the query", 'psql "{PG}localhost/db?$(echo host={H})"'],
  ["a substitution in the userinfo", 'psql "{PG}u:$(echo p@{H}:5432/x?)@localhost/db"'],
  ["a backtick substitution in the path", "psql \"{PG}localhost/`echo 'db?host={H}'`\""],
  [
    "single quotes keep the text, the guard still asks",
    "psql '{PG}u@localhost:$(cat /tmp/port)/db' -c 'select 1'",
  ],
  ["read binds a conninfo word", "read DB <<< 'x host={H}'; psql \"host=localhost dbname=$DB\""],
  ["a substitution in a conninfo word", 'psql "host=localhost $(echo host={H})"'],
  [
    "-d with a bound conninfo word",
    "read DB <<< 'x host={H}'; psql -d \"host=localhost dbname=$DB\"",
  ],
  [
    "pg_dump conninfo with a bound word",
    "read D <<< 'x host={H}'; pg_dump \"host=localhost dbname=$D\"",
  ],
  [
    "pg_isready conninfo with a bound word",
    "read H2 <<< 'host={H}'; pg_isready -d \"host=localhost $H2\"",
  ],
  ["pg_dump with a bound port", "read P <<< '1@{H}'; pg_dump \"{PG}localhost:$P/db\""],
  ["-d with a bound port", "read P <<< '1@{H}'; psql -d \"{PG}localhost:$P/db\""],
  ["--dbname= with a substitution", "psql --dbname=\"{PG}localhost/$(echo '?host={H}')\""],
  ["redis -u with a bound port", "read PORT <<< '1@{H}'; redis-cli -u \"{R}localhost:$PORT\""],
  ["redis with a substitution", 'redis-cli -u "{R}localhost:$(echo 1@{H})"'],
  ["mongosh with a bound port", "read PORT <<< '1@{H}'; mongosh \"{M}localhost:$PORT/db\""],
  ["mongosh with a substitution", 'mongosh "{M}localhost:$(echo 1@{H})/db"'],
  [
    "mongodump --uri with a bound port",
    "read PORT <<< '1@{H}'; mongodump --uri \"{M}localhost:$PORT/db\"",
  ],
  ["mysql URI with a substitution", 'mysqlsh "mysql://u@localhost:$(echo 1@{H})/db"'],
  [
    "clickhouse with a bound port",
    "read PORT <<< '1@{H}'; clickhouse-client \"clickhouse://localhost:$PORT/db\"",
  ],
  [
    "a nested shell string binds the port",
    "bash -c 'read PORT <<< 1@{H}; psql \"{PG}localhost:$PORT/db\"'",
  ],
  ["a wrapper in front", "read PORT <<< '1@{H}'; sudo psql \"{PG}localhost:$PORT/db\""],
];

describe("D1: an unplaceable variable or substitution inside a URI of a local host is never an allow", () => {
  it.each(UNPLACEABLE)("%s", (_name, template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).not.toBe("allow");
  });

  it("asks (a human decides) rather than denying: the guard does not know what the substitution prints", () => {
    expect(decide(fill('psql "{PG}localhost:$(echo 1@{H})/db"'))).toBe("ask");
    expect(decide(fill("read PORT <<< '1@{H}'; psql \"{PG}localhost:$PORT/db\""))).toBe("ask");
  });
});

/** The everyday neighbours: a literal expansion, a plain unbound variable, a local URI with an ordinary port. */
const PLACEABLE: readonly string[] = [
  "PORT=5433; psql \"{PG}localhost:$PORT/db\" -c 'select 1'",
  "export PORT=5433; psql \"{PG}localhost:$PORT/db\" -c 'select 1'",
  "PORT=5433 psql \"{PG}localhost:$PORT/db\" -c 'select 1'",
  "psql \"{PG}localhost:$PORT/db\" -c 'select 1'",
  "psql \"{PG}u@localhost:${PORT}/db\" -c 'select 1'",
  "psql \"{PG}u:$PW@localhost/db\" -c 'select 1'",
  "psql \"{PG}u:p@localhost:5433/db?sslmode=disable\" -c 'select 1'",
  "psql \"host=localhost port=$PORT dbname=db\" -c 'select 1'",
  'PORT=5433; psql "host=localhost port=$PORT dbname=db"',
  'redis-cli -u "{R}localhost:$PORT" ping',
  "mongosh \"{M}localhost:$PORT/db\" --eval 'db.x.find()'",
  'PORT=6380; redis-cli -u "{R}localhost:$PORT" ping',
  'pg_dump "{PG}localhost:5433/db" > /tmp/dump.sql',
  // The database NAME of a local URI, bound by a loop or a read: 54 of the 85 asks of the first corpus measure, every one a script's
  // loop variable. A path variable was never read before wave 10 either: a stated residual (a substitution in the path still asks).
  'for d in a b; do psql "{PG}u@localhost:5433/ds_$d" -c "select 1"; done',
  "read DB <<< 'db'; psql \"{PG}u@localhost:5433/$DB\" -c 'select 1'",
  'name=$(date +%s); psql "{PG}u:p@127.0.0.1:5433/db_$name" -c "select 1"',
];

describe("D1: a name bound unplaceably asks in the port, the userinfo and the query, not in the path", () => {
  it.each([
    ["the port", 'read P <<< 5433; psql "{PG}localhost:$P/db_$P"'],
    ["the password", 'read P <<< x; psql "{PG}u:$P@localhost/db"'],
    ["the query", 'read M <<< disable; psql "{PG}localhost/db?sslmode=$M"'],
    ["a whole query", 'read Q <<< "host=localhost"; psql "{PG}localhost/db?$Q"'],
    ["a later query pair", 'read M <<< x; psql "{PG}localhost/db?host=localhost&x=$M"'],
    ["a conninfo word", 'read D <<< db; psql "host=localhost dbname=$D"'],
  ])("%s asks", (_name, template) => {
    expect(decide(fill(template))).toBe("ask");
  });

  it("a substitution in the path still asks", () => {
    expect(decide(fill('psql "{PG}localhost/db_$(date +%s)"'))).toBe("ask");
  });
});

describe("D1: a literal expansion and a plain unbound variable keep allowing", () => {
  it.each(PLACEABLE)("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("D1: a remote host written out is still refused (the pre-existing reading is intact)", () => {
  it.each([
    'PORT=1@{H}; psql "{PG}localhost:$PORT/db"',
    'export PORT=1@{H}; psql "{PG}localhost:$PORT/db"',
    'psql "{PG}localhost:1@{H}/db"',
    'psql "{PG}localhost/db?host={H}"',
  ])("%s", (template) => {
    expect(decide(fill(template))).toBe("deny");
  });
});
