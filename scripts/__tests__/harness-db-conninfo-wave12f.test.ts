/**
 * Wave 12, part F, F-8 (round-9 R9-ADV-20 conninfo half, R9-COMP-5 PGSERVICE).
 *
 * A program that merely READS a database variable (`bun run test`, `node x.js`, `drizzle-kit push`) was judged for the URI the variable holds, but a variable
 * that holds a libpq CONNECTION STRING was not read at all: `DATABASE_URL="host=<remote>" bun run test` allowed, and with it the second host of
 * `host=chartwarden-postgres,<remote>` and the duplicate `host=chartwarden-postgres host=<remote>` that the project-container exemption was meant to
 * leave alone (real libpq tries each host of a comma list, and the last duplicate `host=` wins). The WHOLE string is read now: every host of a comma
 * list, every `host=` and `hostaddr=`, and the exemption holds only when every one is a local host or a project container. `PGSERVICE` and
 * `PGSERVICEFILE` name a service file that can name a remote host: a program that reads database variables with one of them set asks.
 * Hosts are built from parts.
 */
import { describe, expect, it } from "vitest";
import { anyProgramTarget } from "../harness/db-any-program";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{H}", H);

const PROGRAMS: readonly string[] = [
  "bun run test",
  "node x.js",
  "bunx drizzle-kit push",
  "python3 manage.py migrate",
];

const REMOTE_CONNINFO: readonly string[] = [
  "host={H}",
  "host=chartwarden-postgres,{H}",
  "host={H},chartwarden-postgres",
  "host=chartwarden-postgres host={H}",
  "host={H} host=chartwarden-postgres",
  "host=localhost host={H}",
  "host=localhost,{H}",
  "host=valkey,postgres,{H}",
  "host=chartwarden-postgres hostaddr=1.2.3.4",
  "host=localhost hostaddr=1.2.3.4",
  "hostaddr=1.2.3.4",
  "host=chartwarden-postgres port=5432 host={H} dbname=x",
  "dbname=x host={H} user=u",
  "user=u password=p host={H}",
];

describe("F-8: a connection string held in a database variable is read whole", () => {
  for (const program of PROGRAMS) {
    describe(program, () => {
      it.each(REMOTE_CONNINFO)('DATABASE_URL="%s" is refused', (template) => {
        const cmd = `DATABASE_URL="${fill(template)}" ${program}`;
        expect(decide(cmd), cmd).toBe("deny");
      });
    });
  }

  it.each(REMOTE_CONNINFO)("the exported and statement forms are refused too: %s", (template) => {
    const value = fill(template);
    for (const cmd of [
      `export DATABASE_URL="${value}"; bun run test`,
      `DATABASE_URL="${value}"; export DATABASE_URL; bun run test`,
      `env DATABASE_URL="${value}" bun run test`,
      `export DATABASE_URL="${value}" && bun run test`,
    ]) {
      expect(decide(cmd), cmd).toBe("deny");
    }
  });

  it("any variable name that holds a connection string is read (PGDATABASE is one to libpq)", () => {
    for (const name of ["PGDATABASE", "DB_DSN", "APP_DB", "X"]) {
      const cmd = `${name}="host=${H}" bun run test`;
      expect(decide(cmd), cmd).toBe("deny");
    }
  });

  it("a connection string with an unplaceable variable asks or is refused, never allowed", () => {
    expect(decide('DATABASE_URL="host=$H port=5432" bun run test')).not.toBe("allow");
    expect(decide('DATABASE_URL="host=chartwarden-postgres host=$H" bun run test')).not.toBe(
      "allow",
    );
  });

  it("a generic container name is an ask, as for a URI", () => {
    expect(decide('DATABASE_URL="host=db" bun run test')).toBe("ask");
    expect(decide(`DATABASE_URL="host=chartwarden-postgres,db" bun run test`)).toBe("ask");
  });

  it("local hosts and project containers stay allow, every one of them", () => {
    for (const value of [
      "host=chartwarden-postgres",
      "host=chartwarden-postgres port=5432 dbname=x user=u",
      "host=postgres",
      "host=valkey",
      "host=chartwarden-postgres,valkey",
      "host=localhost",
      "host=localhost port=5433 dbname=x",
      "host=127.0.0.1",
      "host=localhost,127.0.0.1",
      "host=::1",
      "host=/var/run/postgresql",
      "dbname=x user=y",
      "dbname=x",
      "sslmode=disable",
    ]) {
      const cmd = `DATABASE_URL="${value}" bun run test`;
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("a variable the same text binds to a local host is placed, not asked about", () => {
    expect(decide('H=localhost; DATABASE_URL="host=$H port=5432" bun run test')).toBe("allow");
    expect(decide('export H=chartwarden-postgres; DATABASE_URL="host=$H" bun run test')).toBe(
      "allow",
    );
    expect(decide(`H=${H}; DATABASE_URL="host=$H" bun run test`)).toBe("deny");
  });

  it("a connection string libpq would refuse is refused (nothing says which host it names)", () => {
    expect(decide(`DATABASE_URL="host=localhost dbname='x" bun run test`)).toBe("deny");
  });

  it("a connection string libpq would refuse is refused, wherever the open quote is", () => {
    expect(decide(`DATABASE_URL="host=chartwarden-postgres password='x" node x.js`)).toBe("deny");
    expect(decide(`DATABASE_URL="dbname='x host=localhost" bun run test`)).toBe("deny");
  });

  it("a variable the same text binds to a local host is placed in every pair", () => {
    expect(decide('P=5433; H=127.0.0.1; DATABASE_URL="host=$H port=$P" node x.js')).toBe("allow");
    expect(decide('H=localhost; DATABASE_URL="host=chartwarden-postgres,$H" node x.js')).toBe(
      "allow",
    );
  });

  it("a service key marks a connection string by itself, and an empty service file asks about nothing", () => {
    expect(decide('DATABASE_URL="service=prod dbname=x" node x.js')).toBe("ask");
    expect(decide('DATABASE_URL="dbname=x service=prod" bunx drizzle-kit push')).toBe("ask");
    expect(decide("PGSERVICEFILE= bun run test")).toBe("allow");
  });

  it("everyday variables are not read as connection strings", () => {
    for (const cmd of [
      'FOO="bar baz" bun run x',
      'NODE_OPTIONS="--max-old-space-size=4096" bun run x',
      'MESSAGE="the host is down" bun run x',
      'LABEL="hostname=x" bun run x',
      'X="a=b c=d" bun run x',
      "DATABASE_URL=postgres://u:p@localhost:5432/x bun run test",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("a program that cannot start another program does not read the variable", () => {
    expect(decide(`DATABASE_URL="host=${H}" cat file`)).toBe("allow");
    expect(decide(`PGSERVICE=prod echo hi`)).toBe("allow");
  });

  it("anyProgramTarget reads the string whole", () => {
    expect(
      anyProgramTarget("bun", ["run", "test"], [`DATABASE_URL=host=chartwarden-postgres,${H}`], []),
    ).toMatchObject({
      kind: "remote",
      subject: H,
    });
    expect(
      anyProgramTarget(
        "bun",
        ["run", "test"],
        ["DATABASE_URL=host=chartwarden-postgres,valkey"],
        [],
      ),
    ).toBeNull();
    expect(anyProgramTarget("bun", ["run", "test"], [`X=host=${H}`], [])).toMatchObject({
      kind: "remote",
    });
  });
});

describe("F-8: PGSERVICE and PGSERVICEFILE name a file that can name a remote host", () => {
  const SERVICE: readonly string[] = [
    "PGSERVICE=prod bun run db:migrate",
    "PGSERVICE=prod node x.js",
    "PGSERVICEFILE=/tmp/s bun run x",
    "PGSERVICEFILE=pg_service.conf bun run x",
    'PGSERVICE="prod" bunx drizzle-kit push',
    "PGSERVICE=local bun run test",
    "export PGSERVICE=prod; bun run db:migrate",
    "PGSERVICE=prod; export PGSERVICE; bun run db:migrate",
    "env PGSERVICE=prod bun run db:migrate",
    'DATABASE_URL="service=prod" bun run x',
    "PGSERVICE=prod psql -c 1",
    "PGSERVICE=prod pg_dump db",
  ];

  it.each(SERVICE)("%s asks", (cmd) => {
    expect(decide(cmd), cmd).toBe("ask");
  });

  it("an empty service and the other libpq variables are not a finding", () => {
    expect(decide("PGSERVICE= bun run test")).toBe("allow");
    expect(decide("PGCONNECT_TIMEOUT=5 bun run test")).toBe("allow");
    expect(decide("PGPASSFILE=/tmp/pgpass bun run test")).toBe("allow");
    expect(decide("PGSSLMODE=disable bun run test")).toBe("allow");
    expect(decide("PGHOST=localhost PGPORT=5433 bun run test")).toBe("allow");
  });

  it("anyProgramTarget reports the service as an indirection", () => {
    expect(anyProgramTarget("bun", ["run", "x"], ["PGSERVICE=prod"], [])).toEqual({
      kind: "indirect",
      subject: "PGSERVICE=prod",
    });
  });
});
