/**
 * Wave 9, W9-1. `.claude/rules/phi-and-secrets.md`: "No production access from a session. Don't psql ... to non-local
 * hosts." The rule that refuses a non-local database host read `-h HOST`, `--host=HOST`, a URL WITH userinfo and
 * `PGHOST=` for four programs. A URL without userinfo (`psql postgres://HOST/db`), a libpq connection string
 * (`psql "host=HOST dbname=db"`), `-d`/`--dbname` URIs, `pg_dump postgres://HOST/db` and every other client (`mysql`,
 * `redis-cli`, `mongosh`, `clickhouse-client`, `cockroach sql`, `usql`, ...) were allowed. One reader of the database
 * target (`db-target.ts`) now serves every client, with the local-host predicate of `content-scan.ts` unchanged.
 * Every remote name here is built from parts: the repo guard refuses a command that names a non-local database host.
 */
import { describe, expect, it } from "vitest";
import { databaseTarget } from "../harness/db-target";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example${"."}com`;
const IP = "203.0.113.9";
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{H}", H).replaceAll("{IP}", IP);

/** Spellings of a remote host, per client. `{H}` is the remote name. */
const LIBPQ_SPELLINGS: readonly string[] = [
  "{C} -h {H}",
  "{C} -h{H}",
  "{C} --host={H}",
  "{C} --host {H}",
  "{C} --ho={H}",
  "{C} -U u -p 5432 -h {H} db",
  "{C} -h {H} -U u",
  "{C} --host={H}:5432",
  "PGHOST={H} {C}",
  "PGHOSTADDR={IP} {C}",
  "env PGHOST={H} {C}",
  "{C} postgres://{H}/db",
  "{C} postgresql://{H}/db",
  "{C} postgres://{H}:5432/db",
  "{C} postgres://u@{H}/db",
  "{C} postgres://u:pw@{H}:5433/db",
  "{C} postgres://u@127.0.0.1,{H}/db",
  "{C} postgres://[2001:db8::1]/db",
  "{C} postgres://u@%70rod.example.com/db",
  "{C} postgres:///db?host={H}",
  "{C} postgres://localhost/db?host={H}",
  "{C} postgres://localhost/db?hostaddr={IP}",
  '{C} "host={H} dbname=db"',
  '{C} "host = {H}"',
  "{C} \"dbname=db host='{H}'\"",
  '{C} "user=u host=localhost,{H} password=x"',
  '{C} "hostaddr={IP}"',
  '{C} "host=127.0.0.1 hostaddr={IP}"',
  "{C} -d postgres://{H}/db",
  '{C} -d "host={H}"',
  "{C} -dpostgres://{H}/db",
  "{C} --dbname=postgres://{H}/db",
  '{C} --dbname "host={H}"',
  "{C} --db=postgres://{H}/db",
  "{C} \"dbname='postgres://{H}/x'\"",
  "PGHOST=postgres://{H}/db {C}",
];
const LIBPQ_CLIENTS: readonly string[] = [
  "psql",
  "pg_dump",
  "pg_dumpall",
  "pg_restore",
  "pgcli",
  "pg_basebackup",
  "createdb",
  "dropdb",
  "pg_isready",
  "vacuumdb",
  "reindexdb",
  "pgbench",
];
/** A spelling that the client's own grammar does not have (`-d` is a directory for pg_receivewal, ...). */
const NOT_A_SPELLING: ReadonlyMap<string, RegExp> = new Map([
  // createdb / dropdb take a plain database name; their only connection string is `--maintenance-db`.
  ["createdb", /(?:^| )(?:-d|--dbname|--db)/],
  ["dropdb", /(?:^| )(?:-d|--dbname|--db)/],
  // pg_dumpall names the host with -h/--host and takes -d for a connection string; pgbench has no -d.
  ["pgbench", /(?:^| )(?:-d|--dbname|--db)/],
]);

const spellingsOf = (client: string): string[] =>
  LIBPQ_SPELLINGS.filter((s) => !NOT_A_SPELLING.get(client)?.test(s)).map((s) =>
    fill(s.replaceAll("{C}", client)),
  );

describe("a libpq client refuses every spelling of a non-local host", () => {
  for (const client of LIBPQ_CLIENTS) {
    it.each(spellingsOf(client))(`${client}: %s`, (cmd) => {
      expect(decide(cmd), cmd).toBe("deny");
    });
  }

  it.each([
    ["createdb", "--maintenance-db"],
    ["dropdb", "--maintenance-db"],
  ])("%s %s names a connection string", (client, option) => {
    expect(decide(fill(`${client} ${option}=postgres://{H}/db x`)), client).toBe("deny");
  });

  it("psql reads the host after a -c command and a -f file", () => {
    expect(decide(fill("psql -c 'select 1' -h {H}"))).toBe("deny");
    expect(decide(fill("psql -f x.sql postgres://{H}/db"))).toBe("deny");
    expect(decide(fill("psql -AtXq -h {H} -c 'select 1'"))).toBe("deny");
    expect(decide(fill("psql -AtXqh {H}"))).toBe("deny");
  });

  it("a runner or a wrapper in front does not hide it", () => {
    for (const prefix of [
      "bunx ",
      "npx ",
      "pnpm exec ",
      "sudo ",
      "sudo -u postgres ",
      "time ",
      "nice -n 5 ",
      "env ",
    ]) {
      expect(decide(fill(`${prefix}psql postgres://{H}/db`)), prefix).toBe("deny");
      expect(decide(fill(`${prefix}pg_dump "host={H} dbname=db"`)), prefix).toBe("deny");
    }
  });

  it("a command after && or in a pipeline is judged too", () => {
    expect(decide(fill("echo go && psql postgres://{H}/db -c 'select 1'"))).toBe("deny");
    expect(decide(fill("pg_dump postgres://{H}/db | gzip > /tmp/x.gz"))).toBe("deny");
  });
});

describe("a host set in the same command line before the client", () => {
  it.each([
    "export PGHOST={H}; psql -c 'select 1'",
    "PGHOST={H}; psql -c 'select 1'",
    "export PGHOST={H} && psql -c 'select 1'",
    "export PGHOST={H}\npsql -c 'select 1'",
    "export PGHOSTADDR={IP}; pg_dump db",
    "export MYSQL_HOST={H}; mysql -e 'select 1'",
    "export COCKROACH_URL=postgresql://{H}; cockroach sql",
    "export PGSERVICE=prod; psql",
    "declare -x PGHOST={H}; psql",
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe(template.includes("PGSERVICE") ? "ask" : "deny");
  });

  it.each([
    "export PGHOST=localhost; psql -c 'select 1'",
    "PGHOST=127.0.0.1; psql",
    "export PGHOST={H}",
    "export PGHOST={H}; echo done",
    "export MYSQL_HOST={H}; cat notes.txt",
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("what the reason shows", () => {
  const password = ["Zq8v3", "LmP0x"].join("");
  const reasonOf = (cmd: string): string => classifyBash(cmd, ctx).reason;

  it.each([
    `psql postgres://ops:${password}@${H}/db`,
    `psql -h postgres://ops:${password}@${H}/db`,
    `mongosh mongodb://ops:${password}@${H}/db`,
    `redis-cli -u redis://:${password}@${H}:6379`,
    `mysql mysql://ops:${password}@${H}/db`,
    `psql "host=${H} password=${password}"`,
    `usql postgres://ops:${password}@${H}/db`,
  ])("never carries the password, and names the host: %#", (cmd) => {
    const reason = reasonOf(cmd);
    expect(reason).not.toContain(password);
    expect(reason).toContain(H);
  });

  it("says that a host is refused, that a target cannot be read, and what a human must confirm", () => {
    expect(reasonOf(fill("psql postgres://{H}/db"))).toContain("access to PHI");
    expect(reasonOf('psql "host=\'x"')).toContain("cannot be read");
    expect(reasonOf("psql service=prod")).toContain("service");
    expect(reasonOf('psql "$DATABASE_URL"')).toContain("DATABASE_URL");
  });
});

describe("a service or a password file names the host: a human decides", () => {
  it.each([
    "psql service=prod",
    'psql "service=prod"',
    'psql "dbname=db service=prod"',
    "psql -d service=prod",
    "psql --dbname=service=prod",
    "pg_dump service=prod",
    "PGSERVICE=prod psql",
    "PGSERVICEFILE=/tmp/svc.conf psql",
    "PGPASSFILE=/tmp/pw psql -U u",
    'psql "host=localhost passfile=/tmp/pw"',
    "psql postgres://localhost/db?service=prod",
    "mysql --login-path=prod",
    "mysql --defaults-file=/tmp/my.cnf",
    "pgcli -D prod",
    "pgcli --dsn prod",
  ])("%s", (cmd) => {
    expect(decide(cmd), cmd).toBe("ask");
  });
});

describe("a target the guard cannot read is refused, not allowed", () => {
  it.each([
    'psql "host=\'unterminated dbname=db"',
    'pg_dump "dbname=\'unterminated"',
    'psql "postgres://u@[::1/db"',
  ])("%s", (cmd) => {
    expect(decide(cmd), cmd).toBe("deny");
  });
});

describe("the other database clients", () => {
  const CASES: readonly (readonly [string, readonly string[]])[] = [
    [
      "mysql",
      [
        "mysql -h {H} -e 'select 1'",
        "mysql -h{H}",
        "mysql --host={H}",
        "mysql --host {H} db",
        "mysql -u root -p -h {H}",
        "mysql mysql://{H}/db",
        "mysql mysql://u:pw@{H}:3306/db",
        "MYSQL_HOST={H} mysql",
        "mysql -e 'select 1' -h {H}",
        "mysql --ho={H}",
      ],
    ],
    ["mariadb", ["mariadb -h {H}", "mariadb --host={H}", "mariadb mariadb://{H}/db"]],
    ["mysqldump", ["mysqldump -h {H} db", "mysqldump --host={H} db"]],
    ["mariadb-dump", ["mariadb-dump -h {H} db"]],
    ["mysqladmin", ["mysqladmin -h {H} status"]],
    ["mysqlshow", ["mysqlshow -h {H}"]],
    ["mysqlcheck", ["mysqlcheck -h {H} db"]],
    ["mycli", ["mycli -h {H}", "mycli mysql://{H}/db"]],
    [
      "mysqlsh",
      ["mysqlsh root@{H}", "mysqlsh --uri root@{H}", "mysqlsh mysql://{H}", "mysqlsh --host={H}"],
    ],
    [
      "redis-cli",
      [
        "redis-cli -h {H} ping",
        "redis-cli -h{H} ping",
        "redis-cli -u redis://{H}",
        "redis-cli -u redis://:pw@{H}:6379/0 ping",
        "redis-cli -u rediss://{H}",
        "redis-cli --cluster check {H}:7000",
        "redis-cli -p 6379 -h {H} get a",
      ],
    ],
    ["valkey-cli", ["valkey-cli -h {H}", "valkey-cli -u valkey://{H}"]],
    [
      "mongosh",
      [
        "mongosh mongodb://{H}/db",
        "mongosh mongodb+srv://{H}/db",
        "mongosh mongodb://u:pw@{H}:27017,other/db",
        "mongosh --host {H}",
        "mongosh --host={H}:27017",
        "mongosh --host rs0/{H}:27017",
        "mongosh {H}:27017/db",
        "mongosh {H}/db",
        "mongosh --eval 'db.x.find()' {H}/db",
        "mongosh --uri mongodb://{H}",
      ],
    ],
    ["mongo", ["mongo --host {H}", "mongo mongodb://{H}/db", "mongo {H}/db"]],
    [
      "mongodump",
      [
        "mongodump --uri=mongodb://{H}/db",
        "mongodump --host {H}",
        "mongodump -h {H}",
        "mongodump --uri mongodb+srv://{H}",
      ],
    ],
    ["mongorestore", ["mongorestore --host={H} dump", "mongorestore --uri=mongodb://{H}"]],
    ["mongoexport", ["mongoexport -h {H} -d x -c y"]],
    ["mongoimport", ["mongoimport --uri mongodb://{H}/x"]],
    [
      "clickhouse-client",
      [
        "clickhouse-client --host {H}",
        "clickhouse-client --host={H}",
        "clickhouse-client -h {H}",
        "clickhouse-client -h {H} -q 'select 1'",
        "clickhouse client --host {H}",
      ],
    ],
    [
      "cockroach",
      [
        "cockroach sql --url postgresql://{H}",
        "cockroach sql --url=postgresql://{H}/db",
        "cockroach sql --host {H}",
        "cockroach sql --host={H}:26257",
        "COCKROACH_HOST={H} cockroach sql",
        "COCKROACH_URL=postgresql://{H} cockroach sql",
        "cockroach node status --host {H}",
      ],
    ],
    [
      "usql",
      [
        "usql postgres://{H}/db",
        "usql pg://u@{H}/db",
        "usql mysql://{H}",
        "usql -c 'select 1' postgres://{H}/db",
      ],
    ],
    ["sqlcmd", ["sqlcmd -S {H}", "sqlcmd -S tcp:{H},1433", "sqlcmd -S{H} -Q 'select 1'"]],
    ["trino", ["trino --server {H}:8080", "trino --server https://{H}"]],
    ["cqlsh", ["cqlsh {H}", "cqlsh {H} 9042", "cqlsh -u u {H}"]],
  ];
  for (const [client, commands] of CASES) {
    it.each(commands.map(fill))(`${client}: %s`, (cmd) => {
      expect(decide(cmd), cmd).toBe("deny");
    });
  }

  it("a runner or wrapper in front of another client does not hide it", () => {
    expect(decide(fill("bunx mongosh mongodb://{H}/db"))).toBe("deny");
    expect(decide(fill("env MYSQL_HOST={H} mysql"))).toBe("deny");
    expect(decide(fill("nice mysql -h {H}"))).toBe("deny");
  });
});

describe("the local-host predicate is the existing one, not a wider one", () => {
  it.each([
    "psql -h prod",
    "psql -h prod.db.internal",
    "psql -h db.internal",
    "psql -h localhost.attacker.example",
    "psql -h 10.0.0.5",
    "psql -h 192.168.1.20",
    "psql -h 172.16.0.9",
    "psql postgres://u@prod/db",
    'psql "host=prod"',
    "mysql -h db",
    "redis-cli -h cache",
  ])("%s is not local", (cmd) => {
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each([
    "psql -h minio",
    "psql -h api.localhost",
    "psql -h 0.0.0.0",
    "psql -h 127.0.0.2",
    "psql -h LOCALHOST",
    "redis-cli -h redis",
  ])("%s is local", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("everyday local use keeps allowing", () => {
  it.each([
    "psql -h localhost",
    // the shell removes the backslash: this is `localhost`
    "psql -h l\\ocalhost",
    "psql -h localhost -p 55432 -U postgres",
    "psql -h 127.0.0.1 -p 15432",
    "psql --host=localhost",
    "psql -h ::1",
    "psql -h /var/run/postgresql",
    "psql -h postgres -U app cw",
    "psql -h host.docker.internal cw",
    "psql -p 5433 -U u db",
    "psql db",
    "psql",
    "psql -l",
    "psql -c 'select 1'",
    "psql -c \"select * from t where host = 'x.example.org'\"",
    'psql -c "select 1" -d db',
    "psql -v ON_ERROR_STOP=1 -f x.sql",
    "psql -f x.sql",
    "psql -X -q -A -t -c 'select 1'",
    "psql --set=host=remote.example.org -f x.sql",
    "psql -v host=remote.example.org -f x.sql",
    "psql postgres://u@127.0.0.1:5433/db",
    "psql postgres://127.0.0.1/db",
    "psql postgres://localhost/db",
    "psql postgresql://localhost:5432/db",
    "psql postgres:///db",
    "psql postgres:///db?host=/var/run/postgresql",
    "psql postgres://u@localhost,127.0.0.1/db",
    "psql postgres://[::1]:5432/db",
    // percent-encoding is decoded before the host is judged: this is `localhost`
    "psql postgres://%6Cocalhost/db",
    "psql postgres://u@127%2E0%2E0%2E1:5433/db",
    "psql postgres://u@postgres/cw",
    'psql "host=localhost dbname=db"',
    'psql "host=127.0.0.1,localhost dbname=db"',
    "psql \"host='localhost' port=5433\"",
    'psql "dbname=db"',
    'psql "hostaddr=127.0.0.1"',
    "psql -d postgres://localhost/db",
    'psql -d "host=localhost dbname=db"',
    "psql --dbname=postgres://u@127.0.0.1/db",
    "PGHOST=localhost psql",
    "PGHOST=/var/run/postgresql psql",
    "PGPASSWORD=x psql -h localhost",
    "PGDATABASE=cw psql",
    "pg_dump -h localhost db",
    "pg_dump postgres://localhost/db",
    "pg_dump -Fc -f /tmp/x.sql db",
    "pg_restore -d postgres://localhost/db x.dump",
    "pg_restore -d db x.dump",
    "pg_dumpall -h localhost",
    "pg_basebackup -h localhost -D /tmp/b",
    "createdb -h localhost x",
    "dropdb -h localhost x",
    "pg_isready -h localhost",
    "pg_isready",
    "vacuumdb -h localhost -d x",
    "mysql -u root db",
    "mysql -h localhost -e 'select 1'",
    "mysql -h 127.0.0.1 -P 3307 -u root",
    "mysql -pfoohbar -u root",
    "mysql -S /tmp/mysql.sock",
    "mysql mysql://localhost/db",
    "mysqldump -h localhost db",
    "redis-cli ping",
    "redis-cli -h localhost ping",
    "redis-cli -p 6380 get a:1",
    "redis-cli -u redis://localhost:6379",
    "redis-cli get key:123",
    "redis-cli -h redis ping",
    "redis-cli --cluster check localhost:7000",
    "mongosh",
    "mongosh mydb",
    "mongosh --eval 'db.x.find()'",
    "mongosh --quiet script.js",
    "mongosh mongodb://localhost/db",
    "mongosh localhost:27017/db",
    "mongosh --host localhost",
    "mongodump --uri=mongodb://127.0.0.1/db",
    "clickhouse-client -q 'select 1'",
    "clickhouse-client --host localhost",
    "clickhouse client --query 'select 1'",
    "cockroach sql --insecure",
    "cockroach sql --url postgresql://localhost:26257",
    "cockroach sql --host=127.0.0.1:26257",
    "usql sqlite3:///tmp/x.db",
    "usql postgres://localhost/db",
    "sqlcmd -S localhost,1433 -Q 'select 1'",
    "trino --server localhost:8080",
    "cqlsh localhost",
    "cqlsh",
    "docker exec -it cw-postgres psql -U postgres",
    "docker compose exec postgres psql -U postgres -d cw",
    "docker compose exec -T postgres pg_dump -U postgres cw",
    "echo psql postgres://x.example.org/db",
    "grep -r psql scripts",
    "git log --grep='mysql -h x.example.org'",
    "which psql",
  ])("%s", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });

  it("$DATABASE_URL could point anywhere: ask, for any client", () => {
    expect(decide('psql "$DATABASE_URL" -c "select 1"')).toBe("ask");
    expect(decide('pg_dump "$DATABASE_URL"')).toBe("ask");
    expect(decide('mysql "$DATABASE_URL"')).toBe("ask");
  });
});

describe("databaseTarget, the reader itself", () => {
  const read = (prog: string, args: string[], assigns: string[] = []) =>
    databaseTarget(prog, args, assigns);

  it("names the first non-local host", () => {
    expect(read("psql", ["-h", `localhost,${H}`])).toEqual({ kind: "remote", subject: H });
    expect(read("psql", [`postgres://u@${H}:5432/db`])).toEqual({ kind: "remote", subject: H });
    expect(read("mysql", [`--host=${H}`])).toEqual({ kind: "remote", subject: H });
  });

  it("is null for a program that is not a database client and for a local target", () => {
    expect(read("cat", ["-h", H])).toBeNull();
    expect(read("psql", ["-h", "localhost"])).toBeNull();
    expect(read("psql", [])).toBeNull();
  });

  it("says why it cannot decide", () => {
    expect(read("psql", ["service=prod"])?.kind).toBe("indirect");
    expect(read("psql", ["host='x"])?.kind).toBe("unparsed");
  });
});
