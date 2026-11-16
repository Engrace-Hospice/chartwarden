/**
 * Wave 10, B1-B6 (round-7 R7-CR-3, R7-CR-4, R7-CR-5, R7-CR-6, R7-CR-7, R7-CR-9, R7-ADV-1, R7-ADV-2, R7-ADV-3, R7-ADV-8,
 * R7-ADV-17). Wave 9's database-target reader let a remote host through in three families: a URI whose userinfo holds `?`
 * or `#`, a libpq connection string whose backslash the guard removed, and a flag that was read as the start of a value
 * option (so the next word, `-h HOST`, was swallowed); and it forgot a variable the command line rebinds, or sets inside a
 * nested shell string. Every remote name here is built from parts: the repo guard refuses a command that names a non-local
 * database host.
 */
import { describe, expect, it } from "vitest";
import { databaseTarget } from "../harness/db-target";
import { TARGET_CLIENTS, type TargetClient } from "../harness/db-target-clients";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example${"."}com`;
const PG = `post${"gres"}://`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string => template.replaceAll("{H}", H).replaceAll("{PG}", PG);

const LIBPQ_CLIENTS = ["psql", "pg_dump", "pg_isready", "pgbench", "vacuumdb", "reindexdb"];

/** B1, B2: a URI is read as libpq reads it (userinfo to the first `@` before the first `/`; `#` is not special). */
const URI_SPELLINGS: readonly string[] = [
  "{PG}localhost?@{H}/db",
  "{PG}localhost#@{H}/db",
  "{PG}localhost?x=1@{H}/db",
  "{PG}localhost#x@{H}/db",
  "{PG}u:p@localhost?@{H}:5433/db",
  "{PG}localhost/db#?host={H}",
  "{PG}localhost#x?host={H}",
  "{PG}localhost/db#x?host={H}",
  "{PG}localhost/db#?hostaddr=203.0.113.9",
  "{PG}localhost:5432/db?x=#&host={H}",
  "{PG}[::1]?@{H}/db",
  "{PG}localhost/db?host={H}#frag",
];

describe("B1/B2: a URI is read by libpq's own grammar", () => {
  for (const client of LIBPQ_CLIENTS) {
    it.each(URI_SPELLINGS)(`${client} %s is refused`, (spelling) => {
      const uri = fill(spelling);
      for (const cmd of [
        `${client} '${uri}'`,
        `${client} "${uri}"`,
        ...(client === "pgbench" ? [] : [`${client} -d '${uri}'`, `${client} --dbname='${uri}'`]),
      ]) {
        expect(decide(cmd), cmd).toBe("deny");
      }
    });
  }

  it.each([
    "psql '{PG}u:p@localhost:5433/db?sslmode=disable'",
    "psql '{PG}localhost/db#frag'",
    "psql '{PG}localhost:$PORT/db'",
    "psql '{PG}u@localhost:${PORT}/db'",
    "psql '{PG}u:p%40ss@localhost/db'",
    "psql '{PG}localhost,127.0.0.1/db?target_session_attrs=any'",
    "psql '{PG}/db?host=/var/run/postgresql'",
    "pg_dump '{PG}localhost/db#anything'",
  ])("an ordinary local URI keeps allowing: %s", (template) => {
    expect(decide(fill(template))).toBe("allow");
  });

  it.each([
    // libpq takes the userinfo to the FIRST `@` before the first `/`: the host of this one is `w@localhost`, not local.
    "{PG}u:p@w@localhost/db",
    // a URL parser that ends the authority at `?` or `#` connects to the first host, libpq to the one after the `@`.
    "{PG}{H}?@localhost/db",
    "{PG}{H}#@localhost/db",
    "{PG}{H}?x=1@localhost/db",
  ])("every reading of %s is judged, whichever client parses it", (template) => {
    expect(decide(fill(`psql '${template}'`))).toBe("deny");
    expect(decide(fill(`redis-cli -u '${template.replace("postgres", "redis")}'`))).toBe("deny");
    expect(decide(fill(`mongosh '${template.replace("postgres", "mongodb")}'`))).toBe("deny");
  });

  it("names the host that follows the userinfo", () => {
    expect(databaseTarget("psql", [fill("{PG}localhost?@{H}/db")], [])).toEqual({
      kind: "remote",
      subject: H,
    });
    expect(databaseTarget("psql", [fill("{PG}localhost#x?host={H}")], [])?.kind).toBe("remote");
  });
});

/** B3: libpq's own backslash grammar, inside and outside single quotes; a word it cannot place is refused. */
describe("B3: a libpq connection string is read with libpq's backslashes", () => {
  const CONNINFO_SPELLINGS: readonly string[] = [
    "host=localhost\\ x host={H}",
    "dbname=x\\ y host={H}",
    "user=a\\ b host={H}",
    "user=a\\\\ host={H}",
    "password=a\\ b\\ c host={H}",
    "host='localhost' hostaddr=203.0.113.9",
    "host = {H}",
    "host= {H}",
    "host ={H}",
    "dbname='x\\'y' host={H}",
    "options=-c\\ x=y host={H}",
  ];
  for (const client of LIBPQ_CLIENTS) {
    it.each(CONNINFO_SPELLINGS)(`${client} '%s' is refused`, (spelling) => {
      const text = fill(spelling);
      const dbname =
        client === "pgbench"
          ? []
          : [
              `${client} -d '${text}'`,
              `${client} --dbname '${text}'`,
              `${client} -d"${text}"`,
              `${client} --dbname='${text}'`,
            ];
      for (const cmd of [`${client} '${text}'`, `${client} "${text}"`, ...dbname]) {
        expect(decide(cmd), cmd).toBe("deny");
      }
    });
  }

  it("the unquoted, shell-escaped spelling is refused too", () => {
    expect(decide(fill("psql host=localhost\\ x\\ host={H}"))).toBe("deny");
    expect(decide(fill("psql host=l\\ocalhost dbname=x"))).toBe("allow");
  });

  it.each([
    "psql 'host=localhost dbname=x'",
    "psql 'host=localhost '",
    "psql ' host=localhost'",
    "psql 'host=localhost\\ x'",
    "psql 'dbname=x\\ y host=localhost'",
    "psql 'host=l\\ocalhost'",
    "psql \"host=localhost password='it\\\\'s'\"",
    "psql 'host=localhost password=a\\\\b'",
    "psql 'user=a\\ b'",
    "psql -d 'dbname=x\\ y'",
  ])(
    "a local connection string with a backslash still allows (or is read as libpq reads it): %s",
    (cmd) => {
      // `host=localhost\ x` is the host `localhost x`: not local, so it is refused; the others hold only local hosts.
      const expected = cmd === "psql 'host=localhost\\ x'" ? "deny" : "allow";
      expect(decide(cmd), cmd).toBe(expected);
    },
  );

  it.each(["psql 'host=localhost stray'", "psql 'host=localhost dbname'", "psql 'dbname=x host'"])(
    "a word libpq would refuse is not read as 'nothing found': %s",
    (cmd) => {
      expect(
        databaseTarget(
          cmd.split(" ")[0] as string,
          [cmd.slice(cmd.indexOf(" ") + 1).replace(/^'|'$|^"|"$/g, "")],
          [],
        )?.kind,
      ).toBe("unparsed");
    },
  );
});

/** B5: a slash is part of the host name for every client except MongoDB's tools. */
describe("B5: `rs0/host` is a replica-set name only for MongoDB's tools", () => {
  it.each([
    "psql -h {H}/localhost",
    "psql --host={H}/localhost",
    "PGHOST={H}/localhost psql",
    "mysql -h {H}/localhost",
    "redis-cli -h {H}/localhost",
    "psql 'host={H}/localhost'",
  ])("%s is refused", (template) => {
    expect(decide(fill(template))).toBe("deny");
  });

  it.each([
    "mongosh --host rs0/{H}:27017,other:27017",
    "mongosh --host=rs0/{H}",
    "mongodump --host rs0/{H}",
    "mongosh --host rs0/localhost",
    "mongosh --host rs0/localhost,127.0.0.1",
  ])("%s keeps reading the replica-set form", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe(template.includes("{H}") ? "deny" : "allow");
  });
});

/** B4: what each client's reader does with a flag, a value option or an abbreviation that comes before a host. */
interface RemoteSpelling {
  /** A prefix of the command line that names the remote host (before the other words are placed). */
  readonly env: string;
  readonly args: string;
}

function remoteSpellingsOf(spec: TargetClient): RemoteSpelling[] {
  const out: RemoteSpelling[] = [];
  const hostShort = spec.hostShort?.[0];
  const hostLong = spec.hostLong[0];
  if (hostShort !== undefined) {
    out.push({ env: "", args: `-${hostShort} ${H}` }, { env: "", args: `-${hostShort}${H}` });
  }
  if (hostLong !== undefined) {
    out.push({ env: "", args: `--${hostLong} ${H}` }, { env: "", args: `--${hostLong}=${H}` });
  }
  const stringLong = spec.stringLong[0];
  const uri = spec.positional === "libpq" ? `${PG}${H}/db` : `mongodb://${H}/db`;
  if (stringLong !== undefined) out.push({ env: "", args: `--${stringLong} ${uri}` });
  if (spec.stringShort !== undefined) out.push({ env: "", args: `-${spec.stringShort[0]} ${uri}` });
  if (spec.positional === "libpq") out.push({ env: "", args: `${PG}${H}/db` });
  if (spec.positional === "uri") out.push({ env: "", args: `mysql://${H}/db` });
  if (spec.positional === "host") out.push({ env: "", args: H });
  const hostEnv = spec.hostEnv[0];
  if (hostEnv !== undefined) out.push({ env: `${hostEnv}=${H} `, args: "" });
  return out;
}

/** Every way the table says a client's options can precede a host: flags, valued options in each spelling, abbreviations. */
function precedingWords(spec: TargetClient): string[] {
  const words: string[] = [];
  const known = new Set(
    (
      spec.valueShort +
      (spec.hostShort ?? "") +
      (spec.stringShort ?? "") +
      (spec.aliasShort ?? "") +
      (spec.attachedShort ?? "")
    ).split(""),
  );
  for (const letter of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (!known.has(letter)) words.push(`-${letter}`);
  }
  for (const flag of spec.flagLong ?? []) words.push(`--${flag}`);
  const valued = [...new Set([...spec.valueLong, ...(spec.indirectLong ?? [])])].filter(
    (name) => !spec.hostLong.includes(name) && !spec.stringLong.includes(name),
  );
  for (const name of valued) {
    words.push(`--${name}=x`, `--${name} x`);
    if (!spec.exactLong) {
      for (let n = 3; n < name.length; n += 2) words.push(`--${name.slice(0, n)} x`);
    }
  }
  for (const letter of spec.valueShort) {
    if (!(spec.hostShort ?? "").includes(letter) && !(spec.stringShort ?? "").includes(letter)) {
      words.push(`-${letter} x`, `-${letter}x`);
    }
  }
  return words;
}

describe("B4: no flag, value option or abbreviation hides a later host", () => {
  for (const [name, spec] of TARGET_CLIENTS) {
    it(`${name}: every option the table lists, before a remote host`, () => {
      const spellings = remoteSpellingsOf(spec);
      expect(spellings.length, `${name} names a remote host in no spelling`).toBeGreaterThan(0);
      const misses: string[] = [];
      for (const before of precedingWords(spec)) {
        for (const remote of spellings) {
          const cmd = `${remote.env}${name} ${before} ${remote.args}`.trim();
          const verdict = decide(cmd);
          const placed = `${remote.env}${name} ${remote.args} ${before}`.trim();
          if (verdict === "allow" || decide(placed) === "allow") misses.push(`${cmd} / ${placed}`);
        }
      }
      expect(misses.slice(0, 5), `${misses.length} commands allowed`).toEqual([]);
    });
  }

  it("the options the round-7 review showed to be flags are listed as flags", () => {
    const valueShort = (name: string): string => TARGET_CLIENTS.get(name)?.valueShort ?? "";
    const valueLong = (name: string): readonly string[] =>
      TARGET_CLIENTS.get(name)?.valueLong ?? [];
    expect(valueShort("sqlcmd")).not.toContain("W");
    expect(valueLong("trino")).not.toContain("password");
    expect(valueLong("clickhouse-client")).not.toContain("password");
    expect(valueLong("mongodump")).not.toContain("password");
    for (const flag of ["tls", "memkeys"]) {
      expect(TARGET_CLIENTS.get("redis-cli")?.flagLong).toContain(flag);
    }
    expect(TARGET_CLIENTS.get("pgbench")?.flagLong).toContain("log");
    for (const exact of [
      "redis-cli",
      "valkey-cli",
      "mongosh",
      "mongodump",
      "trino",
      "cockroach",
      "sqlcmd",
    ]) {
      expect(TARGET_CLIENTS.get(exact)?.exactLong, exact).toBe(true);
    }
  });

  it("the table is consistent: no flag is also a value option, and the flags that prefix a value option are listed", () => {
    for (const [name, spec] of TARGET_CLIENTS) {
      const valued = new Set([
        ...spec.valueLong,
        ...spec.hostLong,
        ...spec.stringLong,
        ...(spec.aliasLong ?? []),
        ...(spec.indirectLong ?? []),
      ]);
      for (const flag of spec.flagLong ?? []) {
        expect(valued.has(flag), `${name}: ${flag} is listed as a flag and as a value option`).toBe(
          false,
        );
      }
    }
  });

  it.each([
    ["redis-cli --tls -h {H} ping"],
    ["redis-cli --memkeys -h {H}"],
    ["redis-cli --memkeys --memkeys-samples 5 -h {H}"],
    ["valkey-cli --tls -h {H}"],
    ["mongosh --tls {H} --eval 'db.x.find()'"],
    ["mongosh --tls --host {H}"],
    ["mongodump --tls --host {H}"],
    ["mongodump --gzip --password --host {H}"],
    ["pgbench --log -h {H}"],
    ["pgbench --progress-timestamp -h {H}"],
    ["sqlcmd -W -S {H} -Q 'select 1'"],
    ["trino --password --server {H}"],
    ["trino --debug --server https://{H}"],
    ["clickhouse-client --password --host {H}"],
    ["clickhouse-client --secure --host {H}"],
    ["cockroach sql --insecure --host {H}"],
    ["psql --echo-all -h {H}"],
    ["psql --csv -h {H}"],
    ["pg_dump --verbose -h {H} db"],
    ["pg_restore --list -h {H} x.dump"],
    ["createdb --echo -h {H} x"],
  ])("%s is refused", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each([
    "redis-cli --tls -h localhost ping",
    "redis-cli --memkeys -h 127.0.0.1",
    "redis-cli --tls --cacert ca.pem -h localhost ping",
    "mongosh --tls --host localhost",
    "pgbench --log -h localhost",
    "sqlcmd -W -S localhost -Q 'select 1'",
    "sqlcmd -S tcp:localhost,1433 -Q 'select 1'",
    "trino --password --server localhost:8080",
    "psql --csv -h localhost",
  ])("the same shape against a local host allows: %s", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("B4: a host option is found even where an option before it is taken to consume it", () => {
  it.each([
    "psql -c -h {H}",
    "psql -c 'select 1' -d -h {H}",
    "mysql -e -h {H}",
    "redis-cli -a -h {H} ping",
    "mongosh --eval --host {H}",
    "pg_dump -f -h {H} db",
    "redis-cli --pass x -u redis://{H}",
  ])("%s is refused", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });
});

describe("B6: a variable the command line sets is read, wherever and however often it is set", () => {
  it.each([
    "export PGHOST=localhost; export PGHOST={H}; psql -c 'select 1'",
    "PGHOST=localhost; PGHOST={H}; psql -c 'select 1'",
    "PGHOST={H}; PGHOST={H}; psql",
    "PGHOST={H}; PGHOST=localhost; psql",
    "export PGHOST={H}; export PGHOST=localhost; pg_dump db",
    "export PGHOST=${X:-{H}}; psql -c 'select 1'",
    "export PGHOST=$(cat /tmp/host); psql -c 'select 1'",
    "bash -c 'export PGHOST={H}; psql -c \"select 1\"'",
    "sh -c 'export PGHOST={H}; psql -c 1'",
    "bash -lc 'export PGHOST={H}; psql -c 1'",
    "zsh -c 'PGHOST={H}; psql -c 1'",
    "eval 'export PGHOST={H}; psql -c 1'",
    "export PGHOST={H}; bash -c 'psql -c 1'",
    "PGHOST={H} bash -c 'psql -c 1'",
    "PGHOST={H} sh -c 'psql -c 1'",
    "bash -c 'bash -c \\'export PGHOST={H}; psql -c 1\\''",
    'export DATABASE_ADMIN_URL={PG}{H}/db; true; psql "$DATABASE_ADMIN_URL"',
    "export MYSQL_HOST=localhost; export MYSQL_HOST={H}; mysql -e 'select 1'",
    "export COCKROACH_URL={PG}{H}; cockroach sql",
  ])("%s is refused", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).not.toBe("allow");
  });

  it.each([
    "psql $DB",
    'psql -d "$DB"',
    "psql --dbname=$DB",
    'psql "$URL"',
    'psql "$(cat f)"',
    'psql "${DB}"',
    'pg_dump "$URL"',
    'pg_dump -d "$URL"',
    'pgbench "$URL"',
    'redis-cli -u "$URL"',
    'redis-cli --uri "$URL"',
    'mongosh "$URI"',
    'mongosh --uri "$URI"',
    'usql "$DSN"',
    'cockroach sql --url "$URL"',
    "psql \"$URL\" -c 'select 1'",
  ])("a variable or substitution in the place of a target asks: %s", (cmd) => {
    expect(decide(cmd), cmd).toBe("ask");
  });

  it.each([
    'DB={PG}{H}/db; psql "$DB"',
    "DB={PG}{H}/db; psql $DB",
    'DB={PG}{H}/db; psql -d "$DB"',
    'export URL=redis://{H}; redis-cli -u "$URL"',
    "H2={H}; psql -h $H2",
    'export URI=mongodb://{H}/db; mongosh "$URI"',
    'DB=localhost; DB={H}; psql -h "$DB"',
    'DB={PG}{H}/db; DB={PG}localhost/db; psql "$DB"',
    "H2={H}; H2=localhost; psql -h $H2",
    'DB={PG}localhost/db; DB={PG}{H}/db; psql "$DB"',
  ])("a variable the line sets to a remote target is read through: %s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each([
    'DB={PG}localhost/db; psql "$DB"',
    "export PGHOST=localhost; psql -c 'select 1'",
    "export PGHOST=localhost; export PGHOST=127.0.0.1; psql -c 'select 1'",
    "H2=localhost; psql -h $H2",
    "bash -c 'export PGHOST=localhost; psql -c 1'",
    "export PGHOST={H}; echo done",
    "PGHOST={H} true; psql -c 'select 1'",
    'psql -h localhost -c "select $X"',
    'createdb "$NAME"',
    'dropdb "$NAME"',
    'createuser "$ROLE"',
    "pg_restore -j 4 x.dump",
    'mysql -u root "$DB"',
    'mysql -h localhost -u "$USER" -p"$PW" "$DB"',
    'redis-cli -h localhost get "$KEY"',
    'mongosh --eval "db.$COLL.find()"',
    "psql -h localhost -U \"$USER\" -c 'select 1'",
  ])("everyday neighbours keep allowing: %s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("allow");
  });

  it("a variable bound by a heredoc-less nested string does not leak into the outer line", () => {
    expect(decide(fill("bash -c 'export PGHOST={H}'; psql -c 'select 1'"))).toBe("allow");
  });
});

/** What the corpus measure of wave 10 showed: real commands the first version of the reader refused or mis-read. */
describe("B6 corpus regressions: a variable the guard cannot place is asked about, never bent into the target", () => {
  it.each([
    'w=$(cat /tmp/pw) && psql "{PG}postgres:${w}@127.0.0.1:5433/postgres" -c "select 1"',
    'psql "{PG}postgres:$(cat /tmp/pw)@127.0.0.1:5433/postgres" -c "select 1"',
    "psql '{PG}u@localhost:$(cat /tmp/port)/db' -c 'select 1'",
    "psql \"host=localhost port=$PORT dbname=x\" -c 'select 1'",
    'psql() { docker exec c psql -U postgres -c "$1"; }; psql "select * from t where a=\'b\'"',
    "psql 'select a = b'",
  ])("%s keeps allowing", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("allow");
  });

  it.each([
    "w=/tmp/sock; w=$(cat /tmp/host); export PGHOST=$w; psql -c 'select 1'",
    "export PGHOST=$(cat /tmp/host); psql -c 'select 1'",
    "export PGHOST=$HOST; psql -c 'select 1'",
    "export MYSQL_HOST=${H2:-localhost}; mysql -e 'select 1'",
  ])("%s asks (a statement sets the host from something the guard cannot place)", (template) => {
    expect(decide(fill(template)), template).toBe("ask");
  });

  it.each([
    "export w=/tmp/a:$w; w=/tmp/b; psql -h $w db",
    "PGHOST=$(cat /tmp/host) psql -c 'select 1'",
    "psql 'host=localhost stray'",
    "psql 'host=localhost dbname=x stray'",
    'psql "{PG}$(cat /tmp/host)/db" -c "select 1"',
    "psql '{PG}u@`cat /tmp/host`:5432/db'",
  ])("%s is refused", (template) => {
    expect(decide(fill(template)), template).toBe("deny");
  });
});
