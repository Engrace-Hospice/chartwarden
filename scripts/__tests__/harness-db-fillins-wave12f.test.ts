/**
 * Wave 12, part F, F-3 (round-9 R9-ADV-11): fill-ins that supply a host inside a database URI, a connection string or a database-name
 * position still passed wave 11's reader: a local URI whose port holds a pattern substitution (`${P/x/1@HOST}`, also `//`, `/#`, `/%`), a
 * local URI whose query holds a brace expansion that yields `host=HOST`, `psql -h localhost -d {a,host=HOST}`, and a function that builds the URI
 * from `$1` and is called with a value that carries `@HOST`. Any parameter expansion that is not a bare `${NAME}` (the substitution
 * operators `/ # % ^ ,`, a slice, a transformation), any positional parameter and any unexpanded brace expansion inside such a position
 * ASKS (a bare `$NAME` / `${NAME}` keeps its older reading: a placed value is read, an unbound one is an ordinary unset variable).
 * Hosts are built from parts; every row is classification only.
 */
import { describe, expect, it } from "vitest";
import { holdsRewritingFillIn } from "../harness/db-variables";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example.com`;
const PG = `post${"gres"}://`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{H}", H).replaceAll("{PG}", PG);

const SUBSTITUTIONS: readonly string[] = [
  'P=x; psql "{PG}localhost:${P/x/1@{H}}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P/z/y}/db" -c 1',
  'P=x; psql "{PG}localhost:${P//x/1@{H}}/db" -c 1',
  'P=x; psql "{PG}localhost:${P/#x/1@{H}}/db" -c 1',
  'P=x; psql "{PG}localhost:${P/%x/1@{H}}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P#z}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P%z}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P^^}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P,,}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P:0}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P:1:2}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P: -9}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P:(0)}/db" -c 1',
  'P=1@{H}; psql "{PG}localhost:${P@Q}/db" -c 1',
  'X=P; P=1@{H}; psql "{PG}localhost:${!X}/db" -c 1',
  'f() { psql "{PG}localhost:${@}/db" -c 1; }; f 1@{H}',
  'P=1@{H}; psql "{PG}localhost:${#P}/db" -c 1',
  'psql "{PG}localhost/db?${Q/x/host={H}}" -c 1',
  'psql "host=localhost port=${P/x/1}" -c 1',
  'psql "host=localhost dbname=${D/x/y}" -c 1',
  'P=x; psql -d "{PG}localhost:${P/x/1@{H}}/db" -c 1',
  'P=x; psql --dbname="{PG}localhost:${P/x/1@{H}}/db" -c 1',
  'P=x; redis-cli -u "redis://localhost:${P/x/1@{H}}/0" ping',
  'psql "{PG}localhost/db?${Q:-host={H}}" -c 1',
  'Q=host={H}; psql "{PG}localhost/db?${Q:0:20}" -c 1',
  'Q=host={H}; psql "{PG}localhost/db?${Q: -20}" -c 1',
  'psql "{PG}localhost/db?${Q:-a=b}" -c 1',
  'psql "host=localhost ${Q:-host={H}}" -c 1',
  'P=x; mongosh "mongodb://localhost:${P/x/1@{H}}/db"',
  'P=x; mysql "mysql://u@localhost:${P/x/1@{H}}/db"',
  'P=x; pg_dump "{PG}localhost:${P/x/1@{H}}/db"',
  'P=x; pg_dump -d "host=localhost port=${P/x/1@{H}}"',
  'P=x; DATABASE_URL="{PG}localhost:${P/x/1@{H}}/db" bun run db:migrate',
  'P=x; export DATABASE_URL="{PG}localhost:${P/x/1@{H}}/db"; bun run db:migrate',
];

const BRACES: readonly string[] = [
  "psql {PG}localhost/db?{host={H},a=b} -c 1",
  "psql -h localhost -d {a,host={H}} -c 1",
  'psql "{PG}localhost/db?{host={H},a=b}" -c 1',
  "psql {PG}localhost/db?{a,b}={H} -c 1",
  "psql 'host=localhost dbname={a,b}' -c 1",
  "pg_dump {PG}localhost/db?{host={H},a=b}",
  "redis-cli -u redis://localhost/{0,1} ping",
  "mongosh mongodb://localhost/db?{host={H},a=b}",
];

const POSITIONALS: readonly string[] = [
  'f() { psql "{PG}localhost:$1/db" -c 1; }; f 1@{H}',
  'f() { psql "{PG}localhost:${1}/db" -c 1; }; f 1@{H}',
  'f() { psql "{PG}localhost:$2/db" -c 1; }; f x 1@{H}',
  'f() { psql "{PG}localhost/db?$@" -c 1; }; f host={H}',
  'f() { psql "{PG}localhost/db?$*" -c 1; }; f host={H}',
  'f() { psql "host=localhost $1" -c 1; }; f host={H}',
  'f() { psql -d "host=localhost $@" -c 1; }; f host={H}',
  'f() { pg_dump "{PG}localhost:$1/db"; }; f 1@{H}',
  'f() { redis-cli -u "redis://localhost:$1/0" ping; }; f 1@{H}',
  "bash -c 'psql \"{PG}localhost:$1/db\" -c 1' _ 1@{H}",
];

describe("F-3: a fill-in inside a database URI, connection string or database name is never an allow", () => {
  describe("pattern substitutions, slices and transformations in the port, query or a keyword value", () => {
    it.each(SUBSTITUTIONS)("%s", (template) => {
      const cmd = fill(template);
      expect(decide(cmd), cmd).not.toBe("allow");
    });
  });
  describe("brace expansions in a target position", () => {
    it.each(BRACES)("%s", (template) => {
      const cmd = fill(template);
      expect(decide(cmd), cmd).not.toBe("allow");
    });
  });
  describe("positional parameters in a target position", () => {
    it.each(POSITIONALS)("%s", (template) => {
      const cmd = fill(template);
      expect(decide(cmd), cmd).not.toBe("allow");
    });
  });

  it("the local URIs with a substitution ask (not a deny): the host stays local", () => {
    expect(decide(fill('P=x; psql "{PG}localhost:${P/x/1}/db" -c 1'))).toBe("ask");
    expect(decide(fill("psql {PG}localhost/db?{a,b} -c 1"))).toBe("ask");
    expect(decide(fill('f() { psql "{PG}localhost:$1/db" -c 1; }; f 5433'))).toBe("ask");
  });
});

describe("F-3: everyday neighbours stay allow", () => {
  it.each([
    'psql "{PG}localhost:${PORT}/db" -c 1',
    'P=5433; psql "{PG}localhost:${P}/db" -c 1',
    'P=5433; psql "{PG}localhost:$P/db" -c 1',
    'psql "{PG}u:pw@localhost:5432/db" -c 1',
    "psql -h localhost -p 5433 -d db -c 1",
    "psql -h localhost -c \"select '{a,b}'::text[]\"",
    "psql -h localhost -c 'select $1'",
    'psql -h localhost -d db -c "select ${#PATH}"',
    'echo "{PG}localhost:${P/x/1}/db"',
    "psql -h localhost -c '\\\\copy t from stdin'",
    'f() { echo "$1"; }; f hello',
    'f() { psql -h localhost -c "select $1"; }; f 1',
    "psql 'host=localhost dbname=db'",
    'psql "host=localhost port=${PORT} dbname=db" -c 1',
    'psql "{PG}${U:-u}@localhost/db" -c 1',
    'psql "{PG}u:${PW:-x}@localhost:5432/db" -c 1',
    'psql "host=localhost user=${PGUSER:-postgres} dbname=db" -c 1',
    'psql "{PG}localhost/${DB:-x}" -c 1',
    'run() { psql "{PG}localhost:5433/$1" -c "$2"; }; run db "select 1"',
    'run() { psql "{PG}u@localhost/${1}" -c 1; }; run db',
    'run() { psql "{PG}localhost/$@" -c 1; }; run db',
    'run() { psql "{PG}u:pw@localhost:5432/$1?sslmode=disable" -c 1; }; run db',
    'psql "{PG}localhost/x?sslmode=${SSL:-disable}" -c 1',
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("holdsRewritingFillIn", () => {
  it.each([
    "${P/x/y}",
    "${P//x/y}",
    "${P#x}",
    "${P%x}",
    "${P^^}",
    "${P,,}",
    "${P:1:2}",
    "${P:-a=b}",
    "${Q:-host=H}",
    "${P:-1@H}",
    "${H:-a,b}",
    "${P:+a/b}",
    "${P:=a b}",
    "${P@Q}",
    "${1}",
    "${@}",
    "${!X}",
    "${#P}",
    "$1",
    "$@",
    "$*",
    "{a,b}",
    "{1..3}",
    "x{host=H,a=b}",
  ])("%s is a fill-in the guard cannot place", (text) => {
    expect(holdsRewritingFillIn(text)).toBe(true);
  });

  it.each([
    "${P:-x}",
    "${PGUSER:-postgres}",
    "${SSL:-disable}",
    "${P:=5432}",
    "${U:-u}",
    "${X-y}",
    "${P}",
    "$P",
    "${PORT}",
    "localhost:5432",
    "a=b",
    "{}",
    "{a}",
    "{ a, b }",
    "$$",
    "$?",
    `${PG}localhost/$1`,
    `${PG}localhost:5433/\${1}`,
    `${PG}u@localhost/$@`,
  ])("%s is not", (text) => {
    expect(holdsRewritingFillIn(text)).toBe(false);
  });
});
