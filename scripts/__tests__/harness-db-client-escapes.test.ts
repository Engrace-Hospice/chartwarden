/**
 * Wave 7, T1 (round-5 ADV5-1, CRITICAL). `sqlite3 .shell`, `psql \!`, `mysql system` and `pgcli \!` run an operating
 * system command from inside an ordinary database client: `sqlite3 :memory: '.shell echo x > <guard file>'` overwrote
 * the guard under Claude and answered ALLOW, because the escape was recognised only by Codex's interactive-shell
 * check (`isInteractiveShell`, called from `checkCodexShell` and so only under `--codex`). `db-client-escapes.ts` reads
 * the text a client is handed (an argument, a here-string, a heredoc body, what an `echo`/`printf` pipes in) and
 * `classifyBash` now ASKS for a shell escape whatever it names, judges a file the client writes like a redirect
 * target, and refuses a read of a secret file. Codex turns every ask into a deny, so its answer for these stays deny.
 * `classifyBash` is pure: root, home and cwd are injected, and every path "exists".
 */
import { afterAll, describe, expect, it } from "vitest";
import { clientFindings, isDbClient } from "../harness/db-client-escapes";
import { classifyBash, isInteractiveShell } from "../harness/patterns";
import { bashPayload, guardCopy, removeCopies, runClaude, runCodex } from "./_guard-copy";

afterAll(removeCopies);

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const G = "scripts/harness/hard-deadline.ts";
const found = (prog: string, ...texts: string[]) => clientFindings(prog, texts);

describe("isDbClient", () => {
  it.each(["sqlite3", "psql", "pgcli", "mysql", "mariadb", "mycli"])("%s is a client", (p) => {
    expect(isDbClient(p)).toBe(true);
  });
  it.each(["sqlite", "pg_dump", "mysqldump", "cat", "git", ""])("%j is not", (p) => {
    expect(isDbClient(p)).toBe(false);
  });
});

describe("clientFindings: the escapes that run a program", () => {
  it.each<[string, string]>([
    ["sqlite3", ".shell echo x"],
    ["sqlite3", ".system touch /tmp/x"],
    ["sqlite3", "  .shell echo x"],
    ["sqlite3", ".SHELL echo x"],
    ["sqlite3", ".she echo x"],
    ["sqlite3", ".sys echo x"],
    ["sqlite3", "select 1;\n.shell echo x"],
    ["sqlite3", ".load ./ext"],
    ["sqlite3", ".excel"],
    ["sqlite3", ".www"],
    ["sqlite3", ".once -e"],
    ["sqlite3", ".once |cat"],
    ["sqlite3", ".output |tee /tmp/x"],
    ["sqlite3", ".import |echo t"],
    ["sqlite3", ".read |echo"],
    ["psql", "\\! echo x"],
    ["psql", "\\!echo x"],
    ["psql", "select 1; \\! echo x"],
    ["psql", "select 1 \\! echo x"],
    ["psql", "\\o |tee /tmp/x"],
    ["psql", "\\g |cat"],
    ["psql", "\\gx |cat"],
    ["psql", "\\w |cat"],
    ["psql", "\\copy t to program 'cat'"],
    ["psql", "\\copy t from PROGRAM 'echo 1'"],
    ["psql", "\\setenv PAGER 'sh -c x'"],
    ["pgcli", "\\! echo x"],
    ["pgcli", "\\pager cat"],
    ["mysql", "system echo x"],
    ["mysql", "SYSTEM echo x"],
    ["mysql", "\\! echo x"],
    ["mysql", "select 1; system echo x"],
    ["mysql", "pager cat"],
    ["mysql", "\\P cat"],
    ["mysql", "--pager=cat"],
    ["mariadb", "system echo x"],
    ["mycli", "\\! echo x"],
  ])("%s: %j", (prog, text) => {
    expect(found(prog, text)?.shell.length, text).toBeGreaterThan(0);
  });

  it.each<[string, string]>([
    ["sqlite3", "select 1"],
    ["sqlite3", ".tables"],
    ["sqlite3", ".schema"],
    ["sqlite3", ".headers on"],
    ["sqlite3", ".mode csv"],
    ["sqlite3", ".show"],
    ["sqlite3", ".quit"],
    ["sqlite3", "select '.shell' as x"],
    ["sqlite3", "-- .shell is not a command here"],
    ["psql", "select 1"],
    ["psql", "\\d"],
    ["psql", "\\dt public.*"],
    ["psql", "\\l"],
    ["psql", "\\x"],
    ["psql", "\\timing"],
    ["psql", "\\conninfo"],
    ["psql", "select regexp_replace(a, '\\w+', 'x') from t"],
    ["psql", "\\o"],
    ["pgcli", "\\dt"],
    ["mysql", "select 1"],
    ["mysql", "show tables"],
    ["mysql", "select 'system' as x"],
    ["mysql", "--host=localhost"],
  ])("%s: %j is not an escape", (prog, text) => {
    expect(found(prog, text)?.shell.length, text).toBe(0);
  });

  it("returns null for a program that is not a client", () => {
    expect(clientFindings("cat", ["\\! x"])).toBeNull();
  });
});

describe("clientFindings: the files a client writes and reads", () => {
  it.each<[string, string, string[]]>([
    ["sqlite3", ".output /tmp/x.csv", ["/tmp/x.csv"]],
    ["sqlite3", ".ou /tmp/x.csv", ["/tmp/x.csv"]],
    ["sqlite3", ".once /tmp/x.csv", ["/tmp/x.csv"]],
    ["sqlite3", ".once -bom /tmp/x.csv", ["/tmp/x.csv"]],
    ["sqlite3", ".output '/tmp/a b.csv'", ["/tmp/a b.csv"]],
    ["sqlite3", ".backup /tmp/b.db", ["/tmp/b.db"]],
    ["sqlite3", ".backup main /tmp/b.db", ["/tmp/b.db"]],
    ["sqlite3", ".save /tmp/s.db", ["/tmp/s.db"]],
    ["sqlite3", ".clone /tmp/c.db", ["/tmp/c.db"]],
    ["sqlite3", ".log /tmp/l.txt", ["/tmp/l.txt"]],
    ["sqlite3", ".trace /tmp/t.txt", ["/tmp/t.txt"]],
    ["sqlite3", ".open /tmp/o.db", ["/tmp/o.db"]],
    ["sqlite3", ".open --new /tmp/o.db", ["/tmp/o.db"]],
    ["sqlite3", "select writefile('/tmp/w.txt', 'x')", ["/tmp/w.txt"]],
    ["sqlite3", "VACUUM INTO '/tmp/v.db'", ["/tmp/v.db"]],
    ["sqlite3", "attach database '/tmp/a.db' as a", ["/tmp/a.db"]],
    ["psql", "\\o /tmp/x.txt", ["/tmp/x.txt"]],
    ["psql", "select 1 \\g /tmp/x.txt", ["/tmp/x.txt"]],
    ["psql", "\\gx /tmp/x.txt", ["/tmp/x.txt"]],
    ["psql", "\\w /tmp/x.sql", ["/tmp/x.sql"]],
    ["psql", "\\copy t to '/tmp/x.csv' csv", ["/tmp/x.csv"]],
    ["psql", "\\copy (select 1) TO '/tmp/x.csv'", ["/tmp/x.csv"]],
    ["psql", "\\lo_export 1234 /tmp/x.bin", ["/tmp/x.bin"]],
    ["mysql", "tee /tmp/x.txt", ["/tmp/x.txt"]],
    ["mysql", "\\T /tmp/x.txt", ["/tmp/x.txt"]],
    ["mysql", "--tee=/tmp/x.txt", ["/tmp/x.txt"]],
  ])("%s: %j writes %j", (prog, text, writes) => {
    expect(found(prog, text)?.writes, text).toEqual(writes);
    expect(found(prog, text)?.shell, text).toEqual([]);
  });

  it.each<[string, string, string[]]>([
    ["sqlite3", ".read schema.sql", ["schema.sql"]],
    ["sqlite3", ".import data.csv t", ["data.csv"]],
    ["sqlite3", ".import --csv data.csv t", ["data.csv"]],
    ["psql", "\\i schema.sql", ["schema.sql"]],
    ["psql", "\\ir ./schema.sql", ["./schema.sql"]],
    ["psql", "\\include schema.sql", ["schema.sql"]],
    ["psql", "\\copy t from 'data.csv' csv", ["data.csv"]],
    ["psql", "\\lo_import /tmp/x.bin", ["/tmp/x.bin"]],
    ["mysql", "source schema.sql", ["schema.sql"]],
    ["mysql", "\\. schema.sql", ["schema.sql"]],
  ])("%s: %j reads %j", (prog, text, reads) => {
    expect(found(prog, text)?.reads, text).toEqual(reads);
  });

  it("a log or trace that goes to the terminal writes no file", () => {
    expect(found("sqlite3", ".log stderr")?.writes).toEqual([]);
    expect(found("sqlite3", ".log off")?.writes).toEqual([]);
    expect(found("sqlite3", ".trace stdout")?.writes).toEqual([]);
  });
});

describe("ADV5-1: Claude's classifyBash asks for a shell escape whatever it names", () => {
  it.each<[string, string]>([
    ["sqlite3 .shell", `sqlite3 :memory: '.shell echo x > ${G}'`],
    ["sqlite3 .system", "sqlite3 :memory: '.system touch /tmp/x'"],
    ["sqlite3 .shell, a harmless command", "sqlite3 data.db '.shell ls'"],
    ["sqlite3 -cmd", "sqlite3 -cmd '.shell ls' data.db 'select 1'"],
    ["psql -c", String.raw`psql -c '\! echo x'`],
    ["psql --command", String.raw`psql --command='\! ls'`],
    ["psql attached -c", String.raw`psql -c'\! ls'`],
    ["psql host local", String.raw`psql -h localhost -U postgres -c '\! ls'`],
    ["pgcli -c", String.raw`pgcli -c '\! ls'`],
    ["pgcli --command", String.raw`pgcli --command '\! ls'`],
    ["mysql -e", "mysql -e 'system echo x'"],
    ["mysql --execute", "mysql --execute='system ls'"],
    ["mysql backslash", String.raw`mysql -e '\! ls'`],
    ["mysql second statement", "mysql -e 'select 1; system ls'"],
    ["here-string", String.raw`psql <<< '\! ls'`],
    ["heredoc, psql", "psql <<'EOF'\n\\! ls\nEOF"],
    ["heredoc, sqlite3", "sqlite3 data.db <<'EOF'\n.shell ls\nEOF"],
    ["heredoc, mysql", "mysql <<EOF\nsystem ls\nEOF"],
    ["echo piped in", `echo '.shell ls' | sqlite3 data.db`],
    ["printf piped in", String.raw`printf '\\! ls\n' | psql`],
    ["after a harmless statement", "git status; sqlite3 data.db '.shell ls'"],
    ["after an -C chain", "git -C apps -C .. status; sqlite3 :memory: '.shell ls'"],
    ["nested in bash -c", `bash -c "sqlite3 :memory: '.shell ls'"`],
    ["nested in a container", "docker compose exec -T db psql -U postgres -c '\\! ls'"],
    ["abbreviated", "sqlite3 data.db '.sys ls'"],
    ["pipe target", "sqlite3 data.db '.output |tee /tmp/x'"],
  ])("%s", (_name, cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("still denies a production host first (the ask never turns a deny into an ask)", () => {
    expect(d(String.raw`psql -h db.example.com -c '\! ls'`)).toBe("deny");
  });

  it("Codex's own check still refuses these (and nothing it refused is let through)", () => {
    for (const cmd of [
      "sqlite3 data.db '.shell bash'",
      "sqlite3 data.db '.system bash'",
      String.raw`psql -c '\! bash'`,
      String.raw`pgcli --command '\! sh'`,
      "mysql -e 'system bash'",
    ]) {
      expect(isInteractiveShell(cmd), cmd).toBe(true);
      expect(d(cmd), cmd).toBe("ask");
    }
  });

  it("every form Codex's old regexes caught is caught by the shared reader too (no drift)", () => {
    expect(found("sqlite3", ".shell bash")?.shell.length).toBeGreaterThan(0);
    expect(found("sqlite3", ".system bash")?.shell.length).toBeGreaterThan(0);
    expect(found("psql", "\\! bash")?.shell.length).toBeGreaterThan(0);
    expect(found("pgcli", "\\! sh")?.shell.length).toBeGreaterThan(0);
    expect(found("mysql", "system bash")?.shell.length).toBeGreaterThan(0);
  });
});

describe("everyday client commands stay allowed", () => {
  it.each([
    "sqlite3 db.sqlite 'select 1'",
    "sqlite3 :memory: 'select 1'",
    "sqlite3 :memory: '.tables'",
    "sqlite3 -readonly data.db '.schema users'",
    "sqlite3 data.db '.headers on' '.mode csv' 'select * from t'",
    "psql -c 'select 1'",
    "psql -h localhost -U postgres -d chartwarden -c 'select count(*) from patients'",
    String.raw`psql -c '\dt'`,
    String.raw`psql -c '\d users'`,
    "psql -c \"select regexp_replace(a, '\\w+', 'x') from t\"",
    "psql <<'EOF'\nselect 1;\nEOF",
    "psql -f schema.sql",
    "mysql -e 'select 1'",
    "mysql -e 'show tables'",
    "echo select 1 | sqlite3 data.db",
    "sqlite3 :memory: '.output /tmp/out.csv' 'select 1'",
    String.raw`psql -c '\o /tmp/out.txt'`,
    String.raw`psql -c '\copy t to /tmp/out.csv csv'`,
    String.raw`psql -c '\i schema.sql'`,
    "sqlite3 data.db '.read schema.sql'",
    "sqlite3 data.db \"select writefile('/tmp/x.txt', 'a')\"",
    "grep -rn 'sqlite3 .shell' docs",
    "echo '.shell is a sqlite3 dot-command'",
    "git commit -m 'document psql \\! escapes'",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("a file a client writes is judged like a redirect target", () => {
  it.each<[string, string]>([
    ["sqlite3 .output", `sqlite3 :memory: '.output ${G}' 'select 1'`],
    ["sqlite3 .once", `sqlite3 :memory: '.once ${G}' 'select 1'`],
    ["sqlite3 .backup", `sqlite3 :memory: '.backup ${G}'`],
    ["sqlite3 .save", `sqlite3 data.db '.save ${G}'`],
    ["sqlite3 .log", `sqlite3 :memory: '.log ${G}' 'select 1'`],
    ["sqlite3 .trace", `sqlite3 :memory: '.trace ${G}' 'select 1'`],
    ["sqlite3 writefile", `sqlite3 :memory: "select writefile('${G}', 'x')"`],
    ["sqlite3 vacuum into", `sqlite3 data.db "vacuum into '${G}'"`],
    ["sqlite3 heredoc", `sqlite3 data.db <<'EOF'\n.output ${G}\nselect 1;\nEOF`],
    ["psql \\o", String.raw`psql -c '\o ${G}'`],
    ["psql \\g", `psql <<'EOF'\nselect 1 \\g ${G}\nEOF`],
    ["psql \\w", String.raw`psql -c '\w ${G}'`],
    ["psql \\copy to", String.raw`psql -c "\copy t to '${G}'"`],
    ["psql \\lo_export", String.raw`psql -c '\lo_export 1 ${G}'`],
    ["mysql tee", `mysql -e 'tee ${G}'`],
    ["mysql --tee", `mysql --tee=${G} -e 'select 1'`],
  ])("%s onto a protected path asks", (_name, cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });
});

describe("a file a client reads is judged like a read: a secret file is refused", () => {
  it.each([
    String.raw`psql -c '\i apps/backend/.env'`,
    String.raw`psql -c '\ir apps/backend/.env'`,
    String.raw`psql -c "\copy t from 'apps/backend/.env'"`,
    "sqlite3 :memory: '.read apps/backend/.env'",
    "sqlite3 :memory: '.import apps/backend/.env t'",
    "mysql -e 'source apps/backend/.env'",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });
});

describe("the limits stay documented limits (nothing here claims to be read)", () => {
  it.each([
    "psql -f /tmp/script.sql",
    "psql < /tmp/script.sql",
    "sqlite3 data.db < /tmp/script.sql",
    "mysql < /tmp/script.sql",
  ])("%s: the file is not read, so it is allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("the real pinned hooks (on a copy of the guard tree)", () => {
  const SHELL_ESCAPES = [
    `sqlite3 :memory: '.shell echo x > ${G}'`,
    String.raw`psql -c '\! echo x'`,
    "mysql -e 'system echo x'",
    String.raw`pgcli -c '\! echo x'`,
  ];
  it.each(SHELL_ESCAPES)("Claude asks and Codex denies: %s", (cmd) => {
    const dir = guardCopy();
    expect(runClaude(dir, bashPayload(cmd)).decision, "claude").toBe("ask");
    expect(runCodex(dir, bashPayload(cmd)).decision, "codex").toBe("deny");
  });

  it.each(["sqlite3 :memory: '.tables'", "sqlite3 db.sqlite 'select 1'", "psql -c 'select 1'"])(
    "both allow the everyday neighbour: %s",
    (cmd) => {
      const dir = guardCopy();
      expect(runClaude(dir, bashPayload(cmd)).decision, "claude").toBe("allow");
      expect(runCodex(dir, bashPayload(cmd)).decision, "codex").toBe("allow");
    },
  );
});
