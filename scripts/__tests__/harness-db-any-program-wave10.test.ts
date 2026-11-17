/**
 * Wave 10, B8 (round-7 R7-ADV-16, R7-ADV-23, R7-CR-15). A non-local database named for a program that is NOT one of the clients
 * with a table of its own reaches the database all the same: `DATABASE_URL=<remote> bun run db:migrate`, `... node x.js`, `...
 * drizzle-kit push`, `... npx knex migrate:latest`, `bun run db:migrate --url <remote>`. The variable or the URI is read for every
 * program that is not one that only prints, searches or moves text. The client table also gains the libpq tools that were missing
 * (`createuser`, `dropuser`, `clusterdb`, `pg_amcheck`, `redis-benchmark`) and the tools of the finding. Every remote name is
 * built from parts.
 */
import { describe, expect, it } from "vitest";
import { anyProgramTarget } from "../harness/db-any-program";
import { TARGET_CLIENTS } from "../harness/db-target-clients";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example${"."}com`;
const PG = `post${"gres"}://`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{H}", H).replaceAll("{PG}", PG);

const PROGRAMS: readonly string[] = [
  "bun run db:migrate",
  "bun scripts/db/migrate.ts",
  "node x.js",
  "drizzle-kit push",
  "npx knex migrate:latest",
  "make migrate",
  "./scripts/migrate.sh",
  "python3 manage.py migrate",
  "ruby bin/rails db:migrate",
  "go run ./cmd/migrate",
  "cargo run --bin migrate",
  "php artisan migrate",
  "docker run --rm app",
  "bash scripts/seed.sh",
];

describe("a remote database variable reaches any program that is not a text tool", () => {
  const VARIABLES: readonly string[] = [
    "DATABASE_URL={PG}{H}/x",
    "DATABASE_URL={PG}u:p@{H}:5432/x",
    "DATABASE_ADMIN_URL={PG}{H}/x",
    "DATABASE_PLATFORM_URL={PG}{H}/x",
    "CHARTWARDEN_TEST_DATABASE_URL={PG}{H}/x",
    "REDIS_URL=redis://{H}:6379",
    "MONGODB_URI=mongodb+srv://{H}/x",
    "MYSQL_URL=mysql://{H}/x",
    "PGHOST={H}",
    "PGHOSTADDR=203.0.113.9",
    "MYSQL_HOST={H}",
    "CLICKHOUSE_HOST={H}",
    "COCKROACH_URL={PG}{H}",
    "ETCDCTL_ENDPOINTS={H}:2379",
  ];
  for (const variable of VARIABLES) {
    it.each(PROGRAMS)(`${variable.split("=")[0]}: %s`, (program) => {
      const text = fill(variable);
      for (const cmd of [
        `${text} ${program}`,
        `export ${text}; ${program}`,
        `${text.split("=")[0]}=${text.split("=").slice(1).join("=")}; ${program}`,
        `env ${text} ${program}`,
        `bash -c 'export ${text}; ${program}'`,
        `export ${text} && ${program}`,
      ]) {
        expect(decide(cmd), cmd).toBe("deny");
      }
    });
  }

  it.each([
    "DATABASE_URL={PG}localhost:5433/x",
    "DATABASE_URL={PG}u:p@127.0.0.1:5433/x",
    "DATABASE_URL={PG}postgres:5432/x",
    "DATABASE_URL={PG}localhost/x?host=/var/run/postgresql",
    "REDIS_URL=redis://localhost:6380",
    "REDIS_URL=redis://redis:6379/0",
    "PGHOST=localhost",
    "PGHOST=/var/run/postgresql",
    "MYSQL_HOST=127.0.0.1",
    "DATABASE_URL=$LOCAL_URL",
  ])("%s (a local value) keeps allowing", (variable) => {
    for (const program of PROGRAMS) {
      const cmd = `${fill(variable)} ${program}`;
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("a text tool is not a program that connects", () => {
  it.each([
    "echo {PG}{H}/db",
    "printf '%s' {PG}{H}/db",
    "cat notes.txt",
    "grep -r {PG}{H}/db scripts",
    "rg '{PG}{H}' scripts",
    "git commit -m 'use {PG}{H}/db'",
    "git log --grep={PG}{H}/db",
    "sed -i 's|a|{PG}{H}/db|' /tmp/x",
    "cp /tmp/x /tmp/y",
    "ls scripts",
    "jq . /tmp/x.json",
    "export PGHOST={H}",
    "export DATABASE_URL={PG}{H}/x",
    "export PGHOST={H}; echo done",
    "export MYSQL_HOST={H}; cat notes.txt",
    "PGHOST={H}; git status",
    "PGHOST={H} true",
    "DATABASE_URL={PG}{H}/x git status",
  ])("%s", (template) => {
    expect(decide(fill(template)), template).toBe("allow");
  });
});

describe("a database URI in the words of a program that is not a text tool", () => {
  const URIS: readonly string[] = [
    "{PG}{H}/x",
    "postgresql://u:p@{H}:5432/x",
    "mysql://{H}/x",
    "mariadb://{H}/x",
    "mongodb://{H}/x",
    "mongodb+srv://{H}/x",
    "redis://{H}",
    "rediss://:pw@{H}:6380",
    "clickhouse://{H}:9000",
    "cockroachdb://{H}:26257",
    "sqlserver://{H}:1433",
    "cassandra://{H}:9042",
    "jdbc:postgresql://{H}/x",
    "{PG}localhost?@{H}/x",
    "{PG}localhost/x?host={H}",
  ];
  it.each(URIS)(
    "%s: a program that is not a client asks; a client with a table of its own refuses",
    (uri) => {
      for (const cmd of [
        `bun run db:migrate --url ${uri}`,
        `bun run db:migrate --url=${uri}`,
        `node x.js ${uri}`,
        `npx knex migrate:latest --connection ${uri}`,
        `flyway -url=${uri} migrate`,
        `alembic -x url=${uri} upgrade head`,
        `docker run -e DATABASE_URL=${uri} app`,
      ]) {
        const text = fill(cmd);
        expect(decide(text), text).toBe("ask");
      }
      for (const cmd of [
        `drizzle-kit push --url ${uri}`,
        `dbmate --url ${uri} up`,
        `atlas migrate apply --url ${uri}`,
        `sqlx migrate run --database-url ${uri}`,
        `diesel migration run --database-url=${uri}`,
        `prisma migrate deploy --url ${uri}`,
      ]) {
        const text = fill(cmd);
        expect(decide(text), text).toBe("deny");
      }
    },
  );

  it.each([
    "perl -pi -e 's#a#{PG}{H}:5432/x#' /tmp/x.sh",
    "sed -i 's#^url=.*#url={PG}{H}/x#' /tmp/x.conf",
    "node -e \"console.log('use {PG}{H}/x')\"",
    "bun run notes --message 'see {PG}{H}/x for details'",
    "bun run x -- see:{PG}{H}/x",
  ])("a URI in the middle of a longer word is text, not a target: %s", (template) => {
    expect(decide(fill(template)), template).toBe("allow");
  });

  it("a variable the line sets is expanded; one it cannot place asks", () => {
    for (const cmd of [
      "w=localhost:5433/x; DATABASE_URL={PG}u:p@$w bun run db:migrate",
      "w=localhost:5433/x; export DATABASE_URL={PG}u:p@${w}; bun run db:migrate",
      'export DATABASE_URL="{PG}u:$(cat /tmp/pw)@127.0.0.1:5433/x"; bun run db:migrate',
      "export PGHOST=$(cat /tmp/h) PGUSER=u; true; node x.js",
    ]) {
      const text = fill(cmd);
      expect(decide(text), text).toBe(text.includes("PGHOST") ? "ask" : "allow");
    }
    expect(decide(fill("w={H}:5432/x; DATABASE_URL={PG}u@$w bun run db:migrate"))).toBe("deny");
    expect(decide(fill("DATABASE_URL={PG}u@$UNKNOWN/x bun run db:migrate"))).toBe("ask");
  });

  it.each([
    "bun run db:migrate --url {PG}localhost:5433/x",
    "node x.js {PG}127.0.0.1/x",
    "flyway -url=jdbc:postgresql://localhost/x migrate",
    "docker run -e DATABASE_URL={PG}postgres:5432/x app",
    "bun run db:migrate",
  ])("a local URI keeps allowing: %s", (template) => {
    expect(decide(fill(template)), template).toBe("allow");
  });
});

describe("the clients the table gained", () => {
  const SPELLINGS: ReadonlyArray<readonly [string, string]> = [
    ["createuser", "createuser -h {H} x"],
    ["dropuser", "dropuser -h {H} x"],
    ["clusterdb", "clusterdb -h {H} x"],
    ["pg_amcheck", "pg_amcheck -h {H} x"],
    ["redis-benchmark", "redis-benchmark -h {H} -n 10"],
    ["pgmetrics", "pgmetrics -h {H} db"],
    ["pgweb", "pgweb --url {PG}{H}/x"],
    ["pgweb", "pgweb --host {H}"],
    ["iredis", "iredis -h {H}"],
    ["iredis", "iredis --url redis://{H}"],
    ["mysqlbinlog", "mysqlbinlog -h {H} binlog.000001"],
    ["influx", "influx --host https://{H}:8086 ping"],
    ["nodetool", "nodetool -h {H} status"],
    ["cypher-shell", "cypher-shell -a bolt://{H}:7687"],
    ["cypher-shell", "cypher-shell --address neo4j://{H}"],
    ["etcdctl", "etcdctl --endpoints={H}:2379 get x"],
    ["etcdctl", "etcdctl --endpoints {H}:2379,localhost:2379 get x"],
    ["kcat", "kcat -b {H}:9092 -L"],
    ["dbmate", "dbmate --url {PG}{H}/x up"],
    ["dbmate", "dbmate -u {PG}{H}/x up"],
    ["goose", "goose postgres '{PG}{H}/x' up"],
    ["goose", "goose postgres 'host={H} user=u dbname=d' up"],
    ["atlas", "atlas migrate apply --url {PG}{H}/x"],
    ["prisma", "prisma migrate deploy --url {PG}{H}/x"],
    ["drizzle-kit", "drizzle-kit push --host {H}"],
    ["sqlx", "sqlx migrate run --database-url {PG}{H}/x"],
    ["sqlx", "sqlx migrate run -D {PG}{H}/x"],
    ["diesel", "diesel migration run --database-url {PG}{H}/x"],
  ];
  it.each(SPELLINGS)("%s: %s", (client, template) => {
    expect(TARGET_CLIENTS.has(client), client).toBe(true);
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each([
    "createuser -h localhost x",
    "pg_amcheck -h localhost x",
    "redis-benchmark -h localhost -n 10",
    "pgmetrics -h localhost db",
    "nodetool -h localhost status",
    "kcat -b localhost:9092 -L",
    "dbmate up",
    "sqlx migrate run",
    "etcdctl --endpoints=localhost:2379 get x",
    "pg_upgrade -b /a -B /b -d /c -D /d",
  ])("a local use keeps allowing: %s", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("CQLSH_HOST and PGDATABASE (unverified against the real tools: read conservatively)", () => {
  it.each([
    "CQLSH_HOST={H} cqlsh",
    "export CQLSH_HOST={H}; cqlsh",
    "PGDATABASE={PG}{H}/db pg_dump",
    "PGDATABASE={PG}{H}/db psql",
    "PGDATABASE='host={H} dbname=x' pg_dump",
    "export PGDATABASE={PG}{H}/db; pg_isready",
  ])("%s", (template) => {
    expect(decide(fill(template)), template).toBe("deny");
  });

  it.each([
    "PGDATABASE=cw pg_dump",
    "CQLSH_HOST=localhost cqlsh",
    "PGDATABASE={PG}localhost/db psql",
  ])("%s keeps allowing", (template) => {
    expect(decide(fill(template)), template).toBe("allow");
  });
});

describe("anyProgramTarget, the reader itself", () => {
  it("is null for a client with a table (its own reader judges it), a text tool and a bare assignment", () => {
    expect(anyProgramTarget("psql", [fill("{PG}{H}/x")], [], [])).toBeNull();
    expect(anyProgramTarget("echo", [fill("{PG}{H}/x")], [], [])).toBeNull();
    expect(anyProgramTarget("", [], [fill("PGHOST={H}")], [])).toBeNull();
  });

  it("names the first remote host", () => {
    // A URI in the words is advisory (an ask); a host variable is a refusal.
    expect(anyProgramTarget("node", [fill("{PG}{H}/x")], [], [])).toEqual({
      kind: "remote",
      subject: H,
      advisory: true,
    });
    expect(anyProgramTarget("node", [], [fill("PGHOST={H}")], [])).toEqual({
      kind: "remote",
      subject: H,
    });
    expect(anyProgramTarget("node", [], [], [fill("PGHOST={H}")])?.subject).toBe(H);
  });
});
