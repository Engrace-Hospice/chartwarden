/**
 * Wave 8, T3 (round-6 CR6-3, ADV6-6, ADV6-5): the database-client reader under real shell quoting, and more clients.
 * Bash collapses `"\\o X"` to `\o X`, but the lexer keeps both backslashes, so `psql -c "\\o CODEOWNERS"`, `psql <<<
 * "\\o |sh"` and `mysql -e "\\! id"` were never read as the escapes they are. psql starts a meta-command at ANY unquoted
 * backslash (`select 1 \o X`). sqlite3 accepts an abbreviation of a command (`.sh` and `.sy` ARE `.system`, `.cl` is `.clone`;
 * minimums read by running every prefix with no argument on sqlite 3.51.0). `.cd DIR` and `.parameter set @f X` change what
 * a later `.output x` and `writefile(@f, …)` name. litecli, usql, duckdb, `cockroach sql`, sqlcmd, sqlplus, mongosh,
 * clickhouse-client and trino join the readers. `classifyBash` is pure: root, home and cwd are injected.
 */
import { describe, expect, it } from "vitest";
import { bothReadings } from "../harness/client-reading";
import { clientFindings, isDbClient } from "../harness/db-client-escapes";
import { classifyBash } from "../harness/patterns";
import { metaCommands } from "../harness/postgres-commands";
import { sqlFileReadings } from "../harness/sql-file-functions";
import { SQLITE_COMMANDS, sqliteCommand } from "../harness/sqlite-commands";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const G = "scripts/harness/hard-deadline.ts";
const S = ".claude/settings.json";
const ENV_FILE = [".", "env"].join("");
const found = (prog: string, text: string, args: readonly string[] = []) =>
  clientFindings(prog, [text], args);

describe("bothReadings: what the client receives after the shell reduced a double-quoted word", () => {
  it.each<[string, string[]]>([
    [String.raw`\\o X`, [String.raw`\\o X`, String.raw`\o X`]],
    [String.raw`\"q\"`, [String.raw`\"q\"`, `"q"`]],
    [String.raw`\$x`, [String.raw`\$x`, "$x"]],
    [String.raw`\o X`, [String.raw`\o X`]],
    ["select 1", ["select 1"]],
  ])("%s", (text, expected) => {
    expect(bothReadings(text)).toEqual(expected);
  });
});

describe("ADV6-6: an escape inside a double-quoted argument is read as the client receives it", () => {
  it.each([
    String.raw`psql -c "\\o CODEOWNERS"`,
    String.raw`psql -c "\\o |sh"`,
    String.raw`psql -c "select 1; \\o ${G}"`,
    String.raw`psql -c "\\copy (select 'x') to ${S}"`,
    String.raw`psql <<< "\\o CODEOWNERS"`,
    String.raw`psql -c"\\o CODEOWNERS"`,
    String.raw`psql --command="\\o CODEOWNERS"`,
    String.raw`mysql -e "\\! id"`,
    String.raw`mysql -e "\\T CODEOWNERS"`,
    String.raw`echo "\\o CODEOWNERS" | psql`,
    `sqlite3 :memory: "select writefile(\\"CODEOWNERS\\",'x')"`,
    String.raw`pgcli -c "\\! id"`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });
});

describe("CR6-3: psql starts a meta-command at any unquoted backslash", () => {
  it.each([
    String.raw`echo 'select 1 \o CODEOWNERS' | psql db`,
    String.raw`psql -c 'select 1 \g CODEOWNERS'`,
    String.raw`psql -c 'select 1; \o CODEOWNERS'`,
    String.raw`psql -c 'select 1 \o CODEOWNERS \\ select 2'`,
    "psql <<'EOF'\nselect 1\n  \\o CODEOWNERS\nEOF",
    String.raw`psql -c '\s CODEOWNERS'`,
    String.raw`psql -c '\w CODEOWNERS'`,
    String.raw`psql -c '\cd scripts \\ \o harness/x.ts'`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each<[string, Array<[string, string]>]>([
    [String.raw`\o X`, [["o", "X"]]],
    [String.raw`select 1 \o X`, [["o", "X"]]],
    [String.raw`select 1; \! id`, [["!", "id"]]],
    [
      String.raw`\o X \\ \g Y`,
      [
        ["o", "X"],
        ["g", "Y"],
      ],
    ],
    [String.raw`select '\o X'`, []],
    [String.raw`select "\o X"`, []],
    [String.raw`select $$\o X$$`, []],
    [String.raw`select $tag$ \o X $tag$ \g Y`, [["g", "Y"]]],
    [String.raw`-- \o X`, []],
    [String.raw`/* \o X */ select 1`, []],
    [String.raw`select regexp_replace(a, '\w+', 'x')`, []],
    [
      "\\o X\n\\g Y",
      [
        ["o", "X"],
        ["g", "Y"],
      ],
    ],
    [String.raw`\\ \o X`, [["o", "X"]]],
    [String.raw`\! echo a \\ b`, [["!", "echo a \\\\ b"]]],
    ["select 1 \\", []],
  ])("metaCommands %j", (text, expected) => {
    expect(metaCommands(text).map((c) => [c.name, c.rest])).toEqual(expected);
  });

  it("a mid-line `\\o` inside single quotes is SQL, not a command", () => {
    expect(found("psql", String.raw`select '\o CODEOWNERS'`)?.writes).toEqual([]);
    expect(found("psql", String.raw`select 1 \o CODEOWNERS`)?.writes).toEqual(["CODEOWNERS"]);
  });
});

/** The fewest letters of each name that sqlite 3.51.0 resolved to it, read once by running every prefix with no argument. */
const PROBED_MINIMUM: Readonly<Record<string, number>> = {
  shell: 2,
  system: 2,
  load: 3,
  excel: 3,
  www: 2,
  output: 1,
  once: 1,
  open: 1,
  backup: 3,
  save: 3,
  clone: 1,
  log: 1,
  trace: 2,
  testcase: 8,
  import: 1,
  read: 3,
  restore: 3,
  archive: 2,
  cd: 2,
  parameter: 3,
};

describe("CR6-3: sqlite3 command abbreviations, every prefix length of every command", () => {
  it("the table names exactly the commands that were probed, with the probed minimums", () => {
    expect(Object.fromEntries(SQLITE_COMMANDS.map((c) => [c.name, c.min]))).toEqual(PROBED_MINIMUM);
  });

  const cases = Object.entries(PROBED_MINIMUM).flatMap(([name, min]) =>
    [...name].map((_, k) => ({ name, prefix: name.slice(0, k + 1), flagged: k + 1 >= min })),
  );

  it.each(cases)(".$prefix of .$name is $flagged", ({ name, prefix, flagged }) => {
    const resolved = sqliteCommand(prefix);
    if (flagged) expect(resolved, `.${prefix}`).toBeDefined();
    // A prefix below the minimum is not THIS command (another command may own it: `.c` is `.clone`, `.l` is `.log`).
    else expect(resolved?.name, `.${prefix}`).not.toBe(name);
  });

  it.each([
    [".sh echo x", "shell"],
    [".sy id", "shell"],
    [".sys id", "shell"],
    [".she id", "shell"],
    [".SH id", "shell"],
    [".exc", "shell"],
    [".ww", "shell"],
    [".cl CLAUDE.md", "write"],
    [".clo CLAUDE.md", "write"],
    [".c CLAUDE.md", "write"],
    [".o CLAUDE.md", "write"],
    [".ou CLAUDE.md", "write"],
    [".on CLAUDE.md", "write"],
    [".op CLAUDE.md", "write"],
    [".bac CLAUDE.md", "write"],
    [".sav CLAUDE.md", "write"],
    [".l CLAUDE.md", "write"],
    [".lo CLAUDE.md", "write"],
    [".tr CLAUDE.md", "write"],
    [".testcase CLAUDE.md", "write"],
    [".i data.csv t", "read"],
    [".rea schema.sql", "read"],
    [".res db.bak", "read"],
  ])("sqlite3 %s is read as a %s", (text, what) => {
    const f = found("sqlite3", text);
    if (what === "shell") expect(f?.shell.length, text).toBeGreaterThan(0);
    else if (what === "write") expect(f?.writes.length, text).toBeGreaterThan(0);
    else expect(f?.reads.length, text).toBeGreaterThan(0);
  });

  it.each([
    ".s",
    ".sa",
    ".ba",
    ".re",
    ".a",
    ".au",
    ".p",
    ".pa",
    ".t",
    ".tab",
    ".tables",
    ".schema",
    ".dump",
    ".headers on",
    ".mode csv",
    ".timer on",
    ".show",
    ".quit",
    ".exit",
    ".echo on",
    ".databases",
    ".indexes",
    ".width 10",
    ".print x",
  ])("sqlite3 %s is no escape and names no file", (text) => {
    const f = found("sqlite3", text);
    expect([f?.shell, f?.writes, f?.reads], text).toEqual([[], [], []]);
  });

  it.each([
    `sqlite3 db '.sh echo x'`,
    `sqlite3 db '.sy id'`,
    `sqlite3 db '.cl ${S}'`,
    `sqlite3 db '.testcase ${S}'`,
    `sqlite3 db '.on ${S}'`,
    `sqlite3 db '.ar -cf ${S} t'`,
    `sqlite3 db '.archive --create --file ${S} t'`,
    `sqlite3 db '.ar -C scripts/harness -x'`,
    `sqlite3 db '.log ${S}'`,
    `sqlite3 db '.restore main ${ENV_FILE}'`.replace("restore main", "res"),
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toMatch(/^(ask|deny)$/);
  });
});

describe("ADV6-6: .cd moves a later relative file, .parameter binds a name", () => {
  it.each([
    `sqlite3 :memory: '.cd scripts/harness' '.output x.ts'`,
    `sqlite3 :memory: '.cd scripts' '.cd harness' '.output x.ts'`,
    "sqlite3 :memory: <<'EOF'\n.cd scripts/harness\n.output x.ts\nEOF",
    `sqlite3 :memory: '.cd ${G.replace("/hard-deadline.ts", "")}' ".once y.txt"`,
    `sqlite3 :memory: '.parameter set @f CODEOWNERS' "select writefile(@f,'x')"`,
    `sqlite3 :memory: '.parameter set :f CODEOWNERS' "select writefile(:f,'x')"`,
    `sqlite3 :memory: '.parameter set $f CODEOWNERS' "select writefile($f,'x')"`,
    `sqlite3 :memory: ".parameter set @f '${S}'" "select writefile(@f,'x')"`,
    `sqlite3 :memory: "select writefile('${S}','x')"`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("a parameter read of a secret file is refused", () => {
    expect(d(`sqlite3 :memory: '.parameter set @f ${ENV_FILE}' "select readfile(@f)"`)).toBe(
      "deny",
    );
    expect(d(`sqlite3 :memory: "select readfile('${ENV_FILE}')"`)).toBe("deny");
    expect(d(`sqlite3 :memory: "select readfile('deploy/production/backend.env')"`)).toBe("deny");
  });

  it("a .cd to somewhere else keeps a relative file out of the guard's way", () => {
    expect(d(`sqlite3 :memory: '.cd /tmp' '.output harness/x.ts'`)).toBe("allow");
    expect(d(`sqlite3 :memory: '.output /tmp/x.csv' 'select 1'`)).toBe("allow");
  });

  it("an unbound parameter names nothing", () => {
    expect(d(`sqlite3 :memory: "select writefile(@f,'x')"`)).toBe("allow");
  });
});

describe("SQL that names a file, in any client", () => {
  it.each<[string, string[], string[]]>([
    ["select readfile('/tmp/a')", ["/tmp/a"], []],
    ["select * from read_csv('/tmp/a.csv')", ["/tmp/a.csv"], []],
    ["select * from read_csv_auto('/tmp/a.csv')", ["/tmp/a.csv"], []],
    ["select * from read_json('/tmp/a.json')", ["/tmp/a.json"], []],
    ["select * from read_parquet('/tmp/a.parquet')", ["/tmp/a.parquet"], []],
    ["select pg_read_file('/tmp/a')", ["/tmp/a"], []],
    ["select lo_import('/tmp/a')", ["/tmp/a"], []],
    ["select load_file('/tmp/a')", ["/tmp/a"], []],
    ["select * from file('/tmp/a', CSV)", ["/tmp/a"], []],
    ["copy t from '/tmp/a.csv'", ["/tmp/a.csv"], []],
  ])("%s reads", (sql, reads) => {
    expect(sqlFileReadings(sql).flatMap((r) => r.reads ?? [])).toEqual(reads);
  });

  it.each<[string, string[]]>([
    ["select writefile('/tmp/a', 'x')", ["/tmp/a"]],
    ["select lo_export(1234, '/tmp/a')", ["/tmp/a"]],
    ["copy t to '/tmp/a.csv' csv", ["/tmp/a.csv"]],
    ["COPY (select 1) TO '/tmp/a.csv'", ["/tmp/a.csv"]],
    ["select * from t into outfile '/tmp/a'", ["/tmp/a"]],
    ["select * from t into dumpfile '/tmp/a'", ["/tmp/a"]],
    ["export database '/tmp/dir'", ["/tmp/dir"]],
    ["vacuum into '/tmp/a.db'", ["/tmp/a.db"]],
    ["vacuum main into '/tmp/a.db'", ["/tmp/a.db"]],
    ["attach database '/tmp/a.db' as a", ["/tmp/a.db"]],
  ])("%s writes", (sql, writes) => {
    expect(sqlFileReadings(sql).flatMap((r) => r.writes ?? [])).toEqual(writes);
  });

  it.each([
    "select load_extension('/tmp/x.so')",
    "select edit('/tmp/x')",
    "exec xp_cmdshell 'dir'",
    "copy t to program 'cat'",
    "load '/tmp/lib.so'",
    "LOAD extension 'x'",
  ])("%s runs code", (sql) => {
    expect(sqlFileReadings(sql).flatMap((r) => r.shell ?? []).length, sql).toBeGreaterThan(0);
  });

  it.each([
    "select 1",
    "select * from t where a = 'copy to'",
    "copy t to stdout",
    "select readfile(@f)",
    "select * from file",
    "select 'a b' as read_csv_name",
  ])("%s names no file", (sql) => {
    const all = sqlFileReadings(sql);
    expect(
      all.flatMap((r) => [...(r.reads ?? []), ...(r.writes ?? []), ...(r.shell ?? [])]),
    ).toEqual([]);
  });

  it("a bound parameter is looked up by the name as typed or without its sigil", () => {
    expect(sqlFileReadings("select readfile(@f)", new Map([["@f", "/tmp/a"]]))).toEqual([
      { reads: ["/tmp/a"] },
    ]);
    expect(sqlFileReadings("select readfile(:f)", new Map([["f", "/tmp/b"]]))).toEqual([
      { reads: ["/tmp/b"] },
    ]);
  });

  it.each([
    `psql -c "select lo_export(1, '${S}')"`,
    `psql -c "copy t to '${S}'"`,
    `mysql -e "select 1 into outfile '${S}'"`,
    `duckdb -c "copy (select 1) to '${S}'"`,
    `clickhouse-client -q "select 1 into outfile '${S}'"`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    `psql -c "select pg_read_file('${ENV_FILE}')"`,
    `psql -c "select lo_import('${ENV_FILE}')"`,
    `duckdb -c "select * from read_csv('${ENV_FILE}')"`,
    `duckdb -c "select * from read_text('deploy/production/backend.env')"`,
    `mysql -e "select load_file('${ENV_FILE}')"`,
    `clickhouse-client -q "select * from file('${ENV_FILE}', 'LineAsString')"`,
  ])("%s is refused as a secret read", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });
});

describe("ADV6-5 / T3(d): clients the table did not name", () => {
  it.each<[string, string]>([
    ["litecli", ".shell id"],
    ["litecli", ".sh id"],
    ["duckdb", ".shell id"],
    ["usql", String.raw`\! id`],
    ["usql", String.raw`\o |sh`],
    ["cockroach", String.raw`\! id`],
    ["sqlcmd", "!!id"],
    ["sqlcmd", ":!!id"],
    ["sqlplus", "host id"],
    ["sqlplus", "HO id"],
    ["sqlplus", "! id"],
    ["mongosh", "require('child_process').execSync('id')"],
    ["clickhouse-client", "select load_extension('x')"],
  ])("%s: %j runs a program", (prog, text) => {
    const args = prog === "cockroach" ? ["sql"] : [];
    expect(found(prog, text, args)?.shell.length, text).toBeGreaterThan(0);
  });

  it.each<[string, string, string[], string[]]>([
    ["litecli", ".output /tmp/x", ["/tmp/x"], []],
    ["duckdb", ".read /tmp/x.sql", [], ["/tmp/x.sql"]],
    ["usql", String.raw`\o /tmp/x`, ["/tmp/x"], []],
    ["usql", String.raw`\i /tmp/x.sql`, [], ["/tmp/x.sql"]],
    ["sqlcmd", ":out /tmp/x", ["/tmp/x"], []],
    ["sqlcmd", ":r /tmp/x.sql", [], ["/tmp/x.sql"]],
    ["sqlplus", "spool /tmp/x.lst", ["/tmp/x.lst"], []],
    ["sqlplus", "save /tmp/x.sql", ["/tmp/x.sql"], []],
    ["sqlplus", "store set /tmp/x.sql", ["/tmp/x.sql"], []],
    ["sqlplus", "@/tmp/x.sql", [], ["/tmp/x.sql"]],
    ["sqlplus", "start /tmp/x.sql", [], ["/tmp/x.sql"]],
    ["sqlplus", "get /tmp/x.sql", [], ["/tmp/x.sql"]],
    ["mongosh", `load("/tmp/x.js")`, [], ["/tmp/x.js"]],
    ["mongosh", `cat('/tmp/x')`, [], ["/tmp/x"]],
    ["mongosh", `fs.writeFileSync("/tmp/x", "y")`, ["/tmp/x"], []],
    ["mongosh", `require('fs').readFileSync('/tmp/x')`, [], ["/tmp/x"]],
  ])("%s: %j", (prog, text, writes, reads) => {
    const f = found(prog, text);
    expect(f?.writes, text).toEqual(writes);
    expect(f?.reads, text).toEqual(reads);
  });

  it("cockroach is a client only as `cockroach sql`", () => {
    expect(isDbClient("cockroach")).toBe(true);
    expect(clientFindings("cockroach", [String.raw`\! id`], ["start"])).toBeNull();
    expect(clientFindings("cockroach", [String.raw`\! id`], ["sql"])?.shell.length).toBeGreaterThan(
      0,
    );
    expect(d(String.raw`cockroach start --insecure`)).toBe("allow");
    expect(d(String.raw`cockroach sql -e '\! id'`)).toBe("ask");
  });

  it.each([
    "litecli",
    "duckdb",
    "usql",
    "sqlcmd",
    "sqlplus",
    "mongosh",
    "clickhouse-client",
    "clickhouse-local",
    "trino",
  ])("%s is a client", (p) => {
    expect(isDbClient(p)).toBe(true);
  });

  it.each([
    String.raw`usql pg://x -c '\! id'`,
    `litecli db -e '.shell id'`,
    `duckdb -c ".shell id"`,
    `sqlcmd -Q '!!id'`,
    `sqlcmd -o ${S} -Q 'select 1'`,
    "sqlcmd -i x -Q ':out CODEOWNERS'",
    `sqlplus -s u/p@x <<< 'host id'`,
    `sqlplus -s u/p@x <<< 'spool ${S}'`,
    `mongosh --eval 'fs.writeFileSync("${S}", "x")'`,
    `mongosh --eval 'require("child_process").execSync("id")'`,
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    `mongosh --eval 'load("${ENV_FILE}")'`,
    `mongosh --eval 'cat("deploy/production/backend.env")'`,
    `psql -f ${ENV_FILE}`,
    `trino --file ${ENV_FILE}`,
    `clickhouse-client --queries-file ${ENV_FILE}`,
    `mysql --defaults-file=${ENV_FILE}`,
    `sqlite3 -init ${ENV_FILE} db`,
    `sqlcmd -i ${ENV_FILE}`,
  ])("%s is refused as a secret read", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });
});

describe("the files a client's own options name", () => {
  it.each<[string, string[], string[], string[]]>([
    ["psql", ["-f", "x.sql"], ["x.sql"], []],
    ["psql", ["--file=x.sql"], ["x.sql"], []],
    ["psql", ["-fx.sql"], ["x.sql"], []],
    ["mysql", ["--defaults-file=my.cnf"], ["my.cnf"], []],
    ["mysql", ["--defaults-extra-file", "my.cnf"], ["my.cnf"], []],
    ["sqlite3", ["-init", "init.sql", "db"], ["init.sql"], []],
    ["sqlcmd", ["-i", "in.sql"], ["in.sql"], []],
    ["sqlcmd", ["-o", "out.txt"], [], ["out.txt"]],
    ["clickhouse-client", ["--queries-file", "q.sql"], ["q.sql"], []],
    ["trino", ["--file", "q.sql"], ["q.sql"], []],
    ["trino", ["-f", "q.sql"], ["q.sql"], []],
    ["mongosh", ["--file", "x.js"], ["x.js"], []],
  ])("%s %j", (prog, args, reads, writes) => {
    const f = clientFindings(prog, [], args);
    expect(f?.reads).toEqual(reads);
    expect(f?.writes).toEqual(writes);
  });

  it("mysql -f is --force, not a file", () => {
    expect(clientFindings("mysql", [], ["-f", "db"])?.reads).toEqual([]);
  });
});

describe("everyday client commands stay allowed", () => {
  it.each([
    "sqlite3 db.sqlite 'select 1'",
    "sqlite3 db.sqlite .tables",
    "sqlite3 db.sqlite .schema",
    "sqlite3 db.sqlite '.schema users'",
    "sqlite3 -header -csv db.sqlite 'select * from t'",
    "psql -c 'select 1'",
    String.raw`psql -c '\dt'`,
    String.raw`psql -c "\\dt"`,
    String.raw`psql -c "select regexp_replace(a, '\\w+', 'x') from t"`,
    String.raw`psql -c "select regexp_replace(a, '\\\\w+', 'x') from t"`,
    String.raw`psql -c "select '\\\\' || 'x'"`,
    "psql -f /tmp/script.sql",
    "psql < /tmp/script.sql",
    "mysql -e 'select 1'",
    "mysql -e 'show tables'",
    String.raw`mysql -e "select 'a\\b'"`,
    "duckdb -c 'select 1'",
    "duckdb :memory: 'select 42'",
    "litecli db.sqlite",
    "usql pg://localhost/db -c 'select 1'",
    "cockroach sql --insecure -e 'select 1'",
    "sqlcmd -Q 'select 1'",
    "mongosh --eval 'db.stats()'",
    "clickhouse-client -q 'select 1'",
    "trino --execute 'select 1'",
    "echo select 1 | sqlite3 db",
    `sqlite3 data.db '.output /tmp/out.csv' 'select 1'`,
    "git commit -m 'document the sqlite3 .sh abbreviation'",
    "grep -rn 'sqlite3 .shell' docs",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});
