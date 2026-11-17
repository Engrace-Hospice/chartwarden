/**
 * Wave 10, B7 (round-7 R7-ADV-9). A client that reconnects from inside its own command language: `psql -c '\c host=H'`,
 * `\connect`, a here-string, a heredoc, what an `echo` pipes in, `dblink_connect('host=H')`, a foreign-server `OPTIONS (host
 * 'H')`, mysql's `connect DB H`, mongosh's `connect("H")`. Wave 9 read the options and the environment, not these.
 * Every remote name is built from parts.
 */
import { describe, expect, it } from "vitest";
import { connectTargetOf } from "../harness/db-connect-commands";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example${"."}com`;
const PG = `post${"gres"}://`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{H}", H).replaceAll("{PG}", PG);

describe("psql, pgcli and usql: \\c and \\connect", () => {
  const COMMANDS: readonly string[] = [
    "\\c host={H}",
    "\\c host={H} dbname=x",
    "\\connect host={H}",
    "\\connect {PG}{H}/db",
    "\\c {PG}{H}/db",
    "\\c -reuse-previous=on host={H}",
    "\\c - - {H}",
    "\\c db u {H} 5432",
    "\\c db - {H}",
    "\\c {H}",
    "\\conn host={H}",
    "select 1; \\c host={H}",
    "select 1 \\\\ \\c host={H}",
  ];
  // usql takes a DSN URL, not a libpq connection string.
  const URI_ONLY = (command: string): boolean =>
    command.includes("{PG}") || /\\c(?:onnect)? (?:- - |db u )?\{H\}/.test(command);
  for (const client of ["psql", "pgcli", "usql"]) {
    it.each(COMMANDS.filter((c) => client !== "usql" || URI_ONLY(c)))(
      `${client}: %s is refused in -c, a here-string, a heredoc and a pipe`,
      (command) => {
        const text = fill(command);
        const forms = [
          `${client} -c '${text}'`,
          `${client} -c "${text.replaceAll("\\", "\\\\")}"`,
          `${client} <<< '${text}'`,
          `${client} <<'EOF'\n${text}\nEOF`,
          `echo '${text}' | ${client}`,
          `printf '%s\\n' '${text}' | ${client}`,
          `${client} -h localhost -c '${text}'`,
        ];
        for (const cmd of forms) expect(decide(cmd), cmd).toBe("deny");
      },
    );
  }

  it.each([
    "\\c mydb",
    "\\c cw",
    "\\c cw postgres localhost 5433",
    "\\c - - localhost",
    "\\c host=localhost dbname=x",
    "\\c {PG}localhost/db",
    "\\c -reuse-previous=on cw",
    "\\conninfo",
    "\\copy t from stdin",
    "\\cd /tmp",
    "\\dt",
    "select 'host=other' as x",
  ])("an ordinary %s keeps allowing", (command) => {
    const text = fill(command);
    for (const cmd of [`psql -c '${text}'`, `psql <<< '${text}'`, `echo '${text}' | psql`]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("a host that looks like a name is read as a host even in the database position", () => {
    expect(connectTargetOf("psql", [fill("\\c {H}")])?.kind).toBe("remote");
    expect(connectTargetOf("psql", ["\\c my.db"])?.kind).toBe("remote");
    expect(connectTargetOf("psql", ["\\c mydb"])).toBeNull();
  });
});

describe("SQL that opens a connection", () => {
  it.each([
    "select dblink_connect('host={H} dbname=x')",
    "select dblink_connect('c1', 'host={H} dbname=x')",
    "select * from dblink('host={H} dbname=x', 'select 1') as t(a int)",
    "select dblink_connect_u('host={H}')",
    "create server s foreign data wrapper postgres_fdw options (host '{H}', dbname 'x')",
    "CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (dbname 'x', hostaddr '{H}')",
    "select dblink_connect('{PG}{H}/db')",
  ])("psql -c %s is refused", (sql) => {
    const cmd = fill(`psql -c "${sql}"`);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each([
    "select dblink_connect('host=localhost dbname=x')",
    "create server s foreign data wrapper postgres_fdw options (host 'localhost')",
    "select 'host=remote.example.org'",
    "select 1 as host",
  ])("psql -c %s keeps allowing", (sql) => {
    expect(decide(`psql -c "${sql}"`)).toBe("allow");
  });
});

describe("mysql and mongosh", () => {
  it.each([
    "mysql -e 'connect db {H}'",
    "mysql -e '\\r db {H}'",
    "mariadb -e 'connect db {H}'",
    "mysql <<< 'connect db {H}'",
    "mongosh --eval 'connect(\"{H}\")'",
    "mongosh --eval 'connect(\"mongodb://{H}/x\")'",
    "mongosh --eval 'db = new Mongo(\"{H}:27017\")'",
    "mongosh --eval \"db = Mongo('mongodb://{H}')\"",
    "mongosh <<< 'connect(\"{H}\")'",
  ])("%s is refused", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each([
    "mysql -e 'connect db localhost'",
    "mysql -e 'connect db'",
    "mysql -e 'select 1'",
    "mongosh --eval 'connect(\"localhost:27017/x\")'",
    "mongosh --eval 'db.x.find()'",
  ])("%s keeps allowing", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("what it cannot read", () => {
  it("a script file the agent wrote is a documented limit", () => {
    expect(decide("psql -f /tmp/reconnect.sql")).toBe("allow");
  });

  it("is null for a program that is not a client", () => {
    expect(connectTargetOf("cat", [fill("\\c host={H}")])).toBeNull();
  });
});
