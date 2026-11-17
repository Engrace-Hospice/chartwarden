/**
 * Wave 12 part E1, E1-2 (R9-ADV-3 and R9-ADV-7, CRITICAL, pre-existing holes of waves 10 and 11):
 *   - `env -S STRING`: the words of the string take the place of the option and env goes on reading its OPTIONS over them (`env -S '-i CMD'`,
 *     `-S '-u X CMD'`, `-S '-C dir CMD'`, `-S '-P dir CMD'`, `-S '-- CMD'`, `-S '-S CMD'`, `env -S '-i' CMD`, `env -i -S '-u X CMD'`);
 *   - env and sudo take EVERY word holding a `=` after its first character as an assignment (`env A.B=x CMD`, `A-B=1`, `1A=x`, `a/b=1`, `P\GHOST=H`);
 *     a NAME holding an expansion the guard cannot place asks.
 * Held against the installed BSD env (echo only; GNU env on Linux is NOT verified here). The non-local host and the live env file are built from parts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { program } from "../harness/command-words";
import { classifyBash } from "../harness/patterns";

const ENV_FILE = `apps/backend/.e${"nv"}`;
const HOST = `prod${"."}example.com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

const GUARDED: ReadonlyArray<readonly [label: string, command: string]> = [
  ["a force push", "git push --force origin main"],
  ["a hook bypass", "git commit --no-verify -m x"],
  ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
  ["a protected write", "cp /tmp/x .claude/settings.json"],
  ["a secret read", `cat ${ENV_FILE}`],
];

/** The options env reads in front of a command, as they may stand INSIDE an `-S` string. */
const LEADING: readonly string[] = [
  "-i",
  "-u X",
  "-C /tmp",
  "-P /bin:/usr/bin",
  "--",
  "-S",
  "-i -u X --",
  "-v",
  "-",
  "-i -i",
  "-S -i",
  "-u X -C /tmp -i",
  "--unset=X",
  "--chdir=/tmp",
  "--ignore-environment",
  "--split-string",
  "-iS",
  "-vS",
];

describe("E1-2: options inside an `env -S` string are env's options", () => {
  const SPELLINGS: ReadonlyArray<readonly [string, (options: string, cmd: string) => string]> = [
    ["inside the string", (o, c) => `env -S '${o} ${c.replace(/'/g, "'\\''")}'`],
    ["options inside, command outside", (o, c) => `env -S '${o}' ${c}`],
    ["after an outer option", (o, c) => `env -i -S '${o} ${c.replace(/'/g, "'\\''")}'`],
    ["after an outer value option", (o, c) => `env -u Y -S '${o} ${c.replace(/'/g, "'\\''")}'`],
    ["--split-string=", (o, c) => `env --split-string='${o} ${c.replace(/'/g, "'\\''")}'`],
    ["joined -S", (o, c) => `env -S'${o} ${c.replace(/'/g, "'\\''")}'`],
    ["joined -S, command outside", (o, c) => `env -S'${o}' ${c}`],
    ["joined -iS, command outside", (o, c) => `env -iS'${o}' ${c}`],
    ["--split-string=, command outside", (o, c) => `env --split-string='${o}' ${c}`],
    ["in a cluster", (o, c) => `env -iS '${o} ${c.replace(/'/g, "'\\''")}'`],
    ["behind sudo", (o, c) => `sudo env -S '${o} ${c.replace(/'/g, "'\\''")}'`],
    ["behind nice", (o, c) => `nice env -S '${o} ${c.replace(/'/g, "'\\''")}'`],
    ["twice", (o, c) => `env -S '${o}' -S '${o} ${c.replace(/'/g, "'\\''")}'`],
  ];
  for (const [label, command] of GUARDED) {
    it(`no leading option makes ${label} weaker`, () => {
      const alone = rank(command);
      expect(alone, `${label} alone`).toBeGreaterThanOrEqual(1);
      const weaker: string[] = [];
      for (const options of LEADING) {
        for (const [name, build] of SPELLINGS) {
          // `--` ends env's options: a second `-S` after it is the command (env runs a program called `-S`), not another string
          if (name === "twice" && options.endsWith("--")) continue;
          const cmd = build(options, command);
          if (rank(cmd) < alone) weaker.push(`${name}: ${cmd}`);
        }
      }
      expect(weaker.slice(0, 5)).toEqual([]);
    });
  }

  it("-C inside the string moves the command into that directory like the option typed outside", () => {
    expect(program("env -S '-C /tmp echo hi'").chdir).toBe("/tmp");
    expect(program("env -C /tmp echo hi").chdir).toBe("/tmp");
    expect(program("env -S '-i -C /tmp echo hi'").chdir).toBe("/tmp");
  });

  it("the reader finds the command in every spelling of a leading option", () => {
    for (const options of LEADING.filter(
      (o) => o !== "-S" && o !== "-iS" && o !== "-vS" && o !== "--split-string" && o !== "-S -i",
    )) {
      const read = program(`env -S '${options} echo HIT'`);
      expect(read.prog, options).toBe("echo");
      expect(read.args, options).toEqual(["HIT"]);
    }
  });

  it("a NAME=value word after the options ends them: env then runs `-i` as the command (probed)", () => {
    expect(program("env -S 'A=b -i echo HIT'").prog).toBe("-i");
  });

  it("nesting: each -S takes the next word as a string, so n of them need n+1 rounds: up to eight rounds are read, more ask (the cap ends in an ask)", () => {
    const deep = (n: number, cmd: string): string => `env -S '${"-S ".repeat(n)}${cmd}'`;
    for (const n of [1, 2, 3, 5, 7]) {
      expect(rank(deep(n, "git push --force origin main")), `${n} rounds`).toBe(2);
    }
    for (const n of [8, 9, 12, 50]) {
      expect(
        rank(deep(n, "git push --force origin main")),
        `${n} rounds must not allow`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        rank(deep(n, "echo hi")),
        `${n} rounds of a harmless command must not allow either`,
      ).toBeGreaterThanOrEqual(1);
    }
    expect(decide(deep(3, "echo hi")), "a harmless nest of three").toBe("allow");
  });

  it("a string env would reject, or one the indices cannot follow, still asks", () => {
    for (const cmd of ["env -S '-i git push \\z'", "env -S '-i ${NOT_SET}'", "env -S", "env -iS"]) {
      expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
    }
  });

  it("the everyday forms stay allowed", () => {
    for (const cmd of [
      "env -S '-i echo hi'",
      "env -S '-u FOO echo hi'",
      "env -S '-C /tmp ls'",
      "env -S '-- echo hi'",
      "env -S '-i' echo hi",
      "env -i -S '-u X echo hi'",
      "env -S '-S echo hi'",
      "env -iS 'echo hi'",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("E1-2: env and sudo take every word with a `=` as an assignment", () => {
  const ASSIGNMENTS = [
    "A.B=x",
    "A-B=1",
    "1A=x",
    "A:B=1",
    "a/b=1",
    "a b=1".replace(" ", "\\ "),
    "P\\GHOST=x",
    "X+=1",
  ];
  for (const [label, command] of GUARDED) {
    it(`no assignment word makes ${label} weaker`, () => {
      const alone = rank(command);
      const weaker: string[] = [];
      for (const assignment of ASSIGNMENTS) {
        for (const wrapper of [
          "env",
          "sudo",
          "env -i",
          "sudo -E",
          "env -u X",
          "/usr/bin/env",
          "sudo env",
          "env env",
        ]) {
          const cmd = `${wrapper} ${assignment} ${command}`;
          if (rank(cmd) < alone) weaker.push(cmd);
        }
      }
      expect(weaker.slice(0, 5)).toEqual([]);
    });
  }

  it("a backslash in the NAME is removed by the shell before env reads it: P\\GHOST=H names PGHOST", () => {
    expect(rank(`env P\\GHOST=${HOST} psql -c 1`)).toBe(2);
    expect(rank(`sudo P\\GHOST=${HOST} psql -c 1`)).toBe(2);
    expect(program(`env A.B=x P\\GHOST=${HOST} psql -c 1`).assigns).toEqual(
      expect.arrayContaining([`PGHOST=${HOST}`, "A.B=x"]),
    );
  });

  it.each([
    `env PG\${E}HOST=${HOST} psql -c 1`,
    "env $N=x psql -c 1",
    `sudo \`echo PG\`HOST=${HOST} psql -c 1`,
    "env $(echo A)=1 ls",
    "sudo $N=1 ls",
    "env A=1 $N=2 ls",
    "env ${N}=x ls",
  ])("a NAME holding an expansion asks: %s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("only env and sudo read a word with an odd name as an assignment (the others run it)", () => {
    expect(program("env A.B=x ls").prog).toBe("ls");
    expect(program("sudo A.B=x ls").prog).toBe("ls");
    expect(program("nice A.B=x ls").prog).toBe("A.B=x");
    expect(program("command A.B=x ls").prog).toBe("A.B=x");
    // the command's own arguments are not assignments
    expect(program("env ls A.B=x").args).toEqual(["A.B=x"]);
  });

  it("the everyday forms stay allowed", () => {
    for (const cmd of [
      "env A.B=x ls",
      "env FOO=bar ls",
      "env -i PATH=/usr/bin ls",
      "sudo FOO=bar ls",
      "env A-B=1 echo hi",
      "env a/b=1 cat README.md",
      "env X= ls",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("held against the REAL env (BSD env on macOS; GNU env on Linux is not verified here)", () => {
  const REAL = "/usr/bin/env";
  const hasSplit =
    existsSync(REAL) && spawnSync(REAL, ["-S", "echo ok"], { encoding: "utf8" }).stdout === "ok\n";
  const run = (args: string[]): string =>
    spawnSync(REAL, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout;

  it
    .skipIf(!hasSplit)
    // GNU env's long options (`--unset=X`, `--chdir=`, `--ignore-environment`) are not BSD env's: the reader accepts both, only BSD env is probed
    .each(
      LEADING.filter(
        (o) =>
          (!o.startsWith("--") || o === "--") && !["-S", "-S -i", "-iS", "-vS", "-"].includes(o),
      ),
    )("env -S '%s echo HIT' prints HIT, and so does the reader's command", (options) => {
    expect(run(["-S", `${options} echo HIT`])).toBe("HIT\n");
    expect(program(`env -S '${options} echo HIT'`).prog).toBe("echo");
  });

  it.skipIf(!hasSplit)("nested -S and the lone dash run the command too", () => {
    expect(run(["-S", "-S echo HIT"])).toBe("HIT\n");
    expect(run(["-S", "- echo HIT"])).toBe("HIT\n");
    expect(program("env -S '-S echo HIT'").prog).toBe("echo");
    expect(program("env -S '- echo HIT'").prog).toBe("echo");
  });

  it.skipIf(!hasSplit).each(["A.B=x", "A-B=1", "1A=x", "A:B=1", "a/b=1", "a=b=c", "A=", "A.B.C=1"])(
    "env %s echo HIT runs echo",
    (assignment) => {
      expect(run([assignment, "echo", "HIT"])).toBe("HIT\n");
      expect(program(`env ${assignment} echo HIT`).prog).toBe("echo");
    },
  );
});
