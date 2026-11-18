/**
 * Wave 11 part C, C4 and C5 (R8-CR-2, R8-CR-3, R8-CR-6, pre-existing since wave 3 and a seam between wave 10's two parts).
 * C4: a shell takes its command string from the first non-option word after ALL its options. `bash -c -- 'CMD'`, `bash -c -x 'CMD'`, `bash -cx 'CMD'`,
 *     `bash -o pipefail -c 'CMD'` hid CMD from every rule. One helper (`shell-command-string.ts`) is held against the installed bash, zsh and sh.
 * C5: a word the guard re-quotes for a nested command (`docker exec`, `docker run`, `ssh`, `find -exec`, `sudo -s`) is read back as the same
 *     word by the readers that do not decode backslashes: `shellQuote` writes a single quote as `'"'"'`.
 * The non-local host and the live env file are built from parts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { words } from "../harness/command-words";
import { nestedTexts } from "../harness/nested-texts";
import { classifyBash } from "../harness/patterns";
import {
  commandOptionValues,
  runsCommandString,
  shellCommandStrings,
} from "../harness/shell-command-string";
import { shellQuote } from "../harness/wrappers";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `apps/backend/.e${"nv"}`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

const NO_VERIFY = "git commit --no-verify -m x";
const FORCE_PUSH = "git push --force origin main";

describe("C4: the command string is the first operand after every option", () => {
  it.each([
    // [shell, args, the string it runs (undefined: none)]
    ["bash", ["-c", "CMD"], "CMD"],
    ["bash", ["-c", "--", "CMD"], "CMD"],
    ["bash", ["-c", "-x", "CMD"], "CMD"],
    ["bash", ["-c", "-e", "CMD"], "CMD"],
    ["bash", ["-c", "+x", "CMD"], "CMD"],
    ["bash", ["+c", "CMD"], "CMD"],
    ["bash", ["-c", "-o", "pipefail", "CMD"], "CMD"],
    ["bash", ["-o", "pipefail", "-c", "CMD"], "CMD"],
    ["bash", ["-O", "extglob", "-c", "CMD"], "CMD"],
    ["bash", ["+O", "extglob", "-c", "CMD"], "CMD"],
    ["bash", ["+o", "nounset", "-c", "CMD"], "CMD"],
    ["bash", ["-cx", "CMD"], "CMD"],
    ["bash", ["-ce", "CMD"], "CMD"],
    ["bash", ["-cl", "CMD"], "CMD"],
    ["bash", ["-lc", "CMD"], "CMD"],
    ["bash", ["-ec", "CMD"], "CMD"],
    ["bash", ["-xc", "CMD"], "CMD"],
    ["bash", ["--norc", "-c", "CMD"], "CMD"],
    ["bash", ["--login", "--noprofile", "-c", "CMD"], "CMD"],
    ["bash", ["--posix", "-c", "CMD"], "CMD"],
    ["bash", ["--rcfile", "f", "-c", "CMD"], "CMD"],
    ["bash", ["--init-file", "f", "-c", "CMD"], "CMD"],
    ["bash", ["-c", "CMD", "arg0", "arg1"], "CMD"],
    ["bash", ["-ce", "--", "CMD"], "CMD"],
    ["sh", ["-c", "--", "CMD"], "CMD"],
    ["sh", ["-ec", "CMD"], "CMD"],
    ["dash", ["-c", "-x", "CMD"], "CMD"],
    ["ksh", ["-c", "--", "CMD"], "CMD"],
    ["zsh", ["-c", "--", "CMD"], "CMD"],
    ["zsh", ["-f", "-c", "CMD"], "CMD"],
    ["ash", ["-c", "CMD"], "CMD"],
    // no -c: the operand is a script file
    ["bash", ["script.sh"], undefined],
    ["bash", ["-x", "script.sh", "CMD"], undefined],
    ["bash", ["-o", "pipefail", "script.sh"], undefined],
    ["bash", ["--", "-c"], undefined],
    // wave 12 (R9-ADV-1): `+c` IS `-c` in bash, sh, dash and zsh (recorded: `harness-shell-options/`), so it moved to the rows above
    // `-c` and no string
    ["bash", ["-c"], undefined],
    ["bash", ["-c", "--"], undefined],
  ] as const)("%s %j", (shell, args, expected) => {
    const got = shellCommandStrings(shell, args);
    if (expected === undefined) expect(got).toEqual([]);
    else expect(got).toContain(expected);
  });

  it("fish, csh and tcsh take the NEXT word as the string, so both readings come back", () => {
    expect(shellCommandStrings("fish", ["-c", "CMD"])).toEqual(["CMD"]);
    expect(shellCommandStrings("fish", ["-c", "--", "CMD"])).toEqual(
      expect.arrayContaining(["CMD", "--"]),
    );
    expect(shellCommandStrings("fish", ["-C", "INIT", "-c", "CMD"])).toEqual(
      expect.arrayContaining(["INIT", "CMD"]),
    );
    expect(shellCommandStrings("fish", ["--command=CMD"])).toEqual(["CMD"]);
    // wave 12: tcsh takes the NEXT word whatever it is, so `-c -x CMD` runs the string `-x` (recorded), not CMD
    expect(shellCommandStrings("tcsh", ["-c", "-x", "CMD"])).toEqual(["-x"]);
    expect(shellCommandStrings("csh", ["-c", "CMD"])).toEqual(["CMD"]);
  });

  it("pwsh takes the rest of its words as one command line", () => {
    expect(shellCommandStrings("pwsh", ["-c", "git", "push"])).toEqual(["git push"]);
    expect(shellCommandStrings("pwsh", ["-Command", "git push"])).toEqual(["git push"]);
    expect(shellCommandStrings("pwsh", ["-NoProfile", "-command", "ls"])).toEqual(["ls"]);
    expect(shellCommandStrings("pwsh", ["-File", "x.ps1"])).toEqual([]);
  });

  it("runsCommandString tells a script operand from a command string", () => {
    expect(runsCommandString("bash", ["-cx", "x"])).toBe(true);
    expect(runsCommandString("bash", ["-x", "x"])).toBe(false);
  });

  it("su, script, flock and runuser: a cluster holding c, attached or not, gives the string", () => {
    expect(commandOptionValues(["-c", "CMD", "user"])).toEqual(["CMD"]);
    expect(commandOptionValues(["-cCMD"])).toEqual(["CMD"]);
    expect(commandOptionValues(["-lc", "CMD"])).toEqual(["CMD"]);
    expect(commandOptionValues(["-qc", "CMD", "/dev/null"])).toEqual(["CMD"]);
    expect(commandOptionValues(["--command", "CMD"])).toEqual(["CMD"]);
    expect(commandOptionValues(["--command=CMD"])).toEqual(["CMD"]);
    expect(commandOptionValues(["-q", "file"])).toEqual([]);
    expect(commandOptionValues(["--", "-c"])).toEqual([]);
  });
});

describe("C4 held against the REAL shells (echo only): the reader runs a string exactly when the shell does", () => {
  const SHELLS = ["bash", "sh", "zsh", "dash"].filter(
    (s) =>
      existsSync(`/bin/${s}`) ||
      existsSync(`/usr/bin/${s}`) ||
      existsSync(`/opt/homebrew/bin/${s}`),
  );
  const CASES: ReadonlyArray<readonly string[]> = [
    ["-c", "echo HIT"],
    ["-c", "--", "echo HIT"],
    ["-c", "-x", "echo HIT"],
    ["-c", "-e", "echo HIT"],
    ["-c", "+x", "echo HIT"],
    ["-cx", "echo HIT"],
    ["-ce", "echo HIT"],
    ["-ec", "echo HIT"],
    ["-xc", "echo HIT"],
    ["-c", "echo HIT", "arg0", "arg1"],
    ["-e", "-c", "echo HIT"],
    ["-x", "script-that-does-not-exist.sh"],
    ["-c"],
    ["--", "-c", "echo HIT"],
  ];
  const SHELL_SPECIFIC: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["bash", ["-o", "pipefail", "-c", "echo HIT"]],
    ["bash", ["-c", "-o", "pipefail", "echo HIT"]],
    ["bash", ["-O", "extglob", "-c", "echo HIT"]],
    ["bash", ["--norc", "-c", "echo HIT"]],
    ["bash", ["--noprofile", "--norc", "-lc", "echo HIT"]],
    ["zsh", ["-o", "pipefail", "-c", "echo HIT"]],
    ["zsh", ["-f", "-c", "echo HIT"]],
  ];
  const all: Array<readonly [string, readonly string[]]> = [
    ...SHELLS.flatMap((s) => CASES.map((c) => [s, c] as const)),
    ...SHELL_SPECIFIC.filter(([s]) => SHELLS.includes(s)),
  ];
  const where = (s: string) =>
    [`/bin/${s}`, `/usr/bin/${s}`, `/opt/homebrew/bin/${s}`].find(existsSync) as string;

  it.each(all)("%s %j", (shell, args) => {
    const real = spawnSync(where(shell), [...args], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
      cwd: "/tmp",
      timeout: 5000,
    });
    const ranHit = /^HIT$/m.test(real.stdout);
    const ours = shellCommandStrings(shell, args).some((s) => s === "echo HIT");
    expect(
      ours,
      `${shell} ${args.join(" ")}: the shell ${ranHit ? "ran" : "did not run"} the string`,
    ).toBe(ranHit);
  });
});

describe("C4 findings: every spelling of the guarded command behind a shell is judged", () => {
  const GUARDED: ReadonlyArray<readonly [string, string]> = [
    ["a force push", FORCE_PUSH],
    ["a hook bypass", NO_VERIFY],
    ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
    ["a protected write", "cp /tmp/x .claude/settings.json"],
    ["a secret read", `cat ${ENV_FILE}`],
  ];
  const SHELL_OPTIONS = [
    "-c",
    "-c --",
    "-c -x",
    "-c -e",
    "-c +x",
    "-c -o pipefail",
    "-o pipefail -c",
    "-cx",
    "-ce",
    "-cl",
    "-lc",
    "-ec",
    "--norc -c",
    "--noprofile --norc -c",
    "--posix -c",
    "-e -c",
    "-x -c --",
  ];
  // wave 12: `-O VAL` and `--rcfile F` are bash options only (zsh's `-O` is a flag, dash and ksh have neither): in the others the words after
  // them are a script file, not a command string, so these two are tried on the bash family alone (the recordings: `harness-shell-options/`)
  const BASH_ONLY_OPTIONS = ["-O extglob -c", "--rcfile f -c"];
  const SHELLS = ["bash", "sh", "zsh", "dash", "ksh", "ash"];
  const optionsOf = (shell: string): string[] =>
    ["bash", "sh", "ash"].includes(shell)
      ? [...SHELL_OPTIONS, ...BASH_ONLY_OPTIONS]
      : SHELL_OPTIONS;
  for (const [label, inner] of GUARDED) {
    it(label, () => {
      const alone = rank(inner);
      expect(alone, `${label} alone`).toBeGreaterThanOrEqual(1);
      const weaker: string[] = [];
      for (const shell of SHELLS) {
        for (const options of optionsOf(shell)) {
          const cmd = `${shell} ${options} ${shellQuote(inner)}`;
          if (rank(cmd) < alone) weaker.push(cmd);
        }
      }
      expect(weaker.slice(0, 5)).toEqual([]);
    });
  }

  const PRODUCERS: ReadonlyArray<readonly [string, (c: string) => string]> = [
    ["eval --", (c) => `eval -- ${shellQuote(c)}`],
    ["eval", (c) => `eval ${shellQuote(c)}`],
    ["sudo shell", (c) => `sudo bash -c -- ${shellQuote(c)}`],
    ["sudo -s", (c) => `sudo -s ${shellQuote(c)}`],
    ["sudo -i", (c) => `sudo -i ${shellQuote(c)}`],
    ["sudo --shell", (c) => `sudo --shell ${shellQuote(c)}`],
    ["sudo --login", (c) => `sudo --login ${shellQuote(c)}`],
    ["sudo -u root -s", (c) => `sudo -u root -s ${shellQuote(c)}`],
    ["sudo -i words", (c) => `sudo -i ${c}`],
    ["ssh local shell", (c) => `ssh localhost bash -c -- ${shellQuote(c)}`],
    ["ssh local string", (c) => `ssh localhost ${shellQuote(c)}`],
    ["docker exec", (c) => `docker exec ctr bash -c -- ${shellQuote(c)}`],
    ["docker run", (c) => `docker run img bash -c -- ${shellQuote(c)}`],
    ["compose exec", (c) => `docker compose exec -T svc sh -c -- ${shellQuote(c)}`],
    ["podman run", (c) => `podman run img sh -c -x ${shellQuote(c)}`],
    ["find -exec", (c) => `find . -name x -exec sh -c -x ${shellQuote(c)} \\;`],
    ["xargs", (c) => `xargs sh -c -- ${shellQuote(c)}`],
    ["watch", (c) => `watch -n 1 bash -c -- ${shellQuote(c)}`],
    ["timeout", (c) => `timeout 5 bash -cx ${shellQuote(c)}`],
    ["su -c", (c) => `su -c ${shellQuote(c)} user`],
    ["su -lc", (c) => `su -lc ${shellQuote(c)} user`],
    ["script -qc", (c) => `script -qc ${shellQuote(c)} /dev/null`],
    ["script -c", (c) => `script -q -c ${shellQuote(c)} /dev/null`],
    ["env -S", (c) => `env -S ${shellQuote(`bash -c -- ${shellQuote(c)}`)}`],
    ["nohup", (c) => `nohup bash -c -- ${shellQuote(c)}`],
    ["csh", (c) => `csh -c ${shellQuote(c)}`],
    ["tcsh", (c) => `tcsh -c ${shellQuote(c)}`],
    ["fish", (c) => `fish -c ${shellQuote(c)}`],
    ["pwsh", (c) => `pwsh -c ${shellQuote(c)}`],
    ["pwsh -Command", (c) => `pwsh -NoProfile -Command ${shellQuote(c)}`],
    ["busybox sh", (c) => `busybox sh -c -- ${shellQuote(c)}`],
  ];
  for (const [producer, build] of PRODUCERS) {
    it(`${producer}: no guarded command gets weaker behind it`, () => {
      const weaker: string[] = [];
      for (const [label, inner] of GUARDED) {
        const alone = rank(inner);
        const cmd = build(inner);
        if (rank(cmd) < alone) weaker.push(`${label}: ${cmd}`);
      }
      expect(weaker).toEqual([]);
    });
  }

  it("the everyday shell forms stay allowed", () => {
    for (const cmd of [
      "bash -c 'echo hi'",
      "bash -lc 'bun run test'",
      "bash -e -c ls",
      "bash -c ls",
      "bash -c -- 'ls scripts'",
      "bash -o pipefail -c 'ls'",
      "bash -cx 'ls'",
      "sh -c 'ls scripts'",
      "zsh -c -- 'echo $HOME'",
      "bash script.sh",
      "bash -x scripts/run.sh",
      "sudo ls",
      "sudo -s",
      "sudo -i ls",
      "sudo -s 'ls scripts'",
      "su -c 'ls' user",
      "script -qc 'ls' /dev/null",
      "eval -- 'ls'",
      "csh -c 'ls'",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("C5: a re-quoted word is read back as the same word", () => {
  const TRICKY = [
    "it's",
    'say "hi"',
    "a\\b",
    "a$b",
    "a`b`",
    "line1\nline2",
    "'",
    "''",
    "a'b'c",
    "\\'",
    "\\\\",
    "$(echo x)",
    "host='h' dbname=d",
    "select dblink_connect('host=h')",
    "  spaced  ",
    "",
    '"\'"',
  ];

  it.each(TRICKY)(
    "shellQuote(%j) is one word the shell and the guard's lexer both read back",
    (text) => {
      const quoted = shellQuote(text);
      expect(quoted).not.toMatch(/'\\''/);
      // the guard's lexer, with and without decoding backslashes: the same word
      expect(words(quoted), quoted).toEqual([text]);
      expect(words(quoted, true), quoted).toEqual([text]);
      // and the real shell
      const real = spawnSync("/bin/sh", ["-c", `printf %s ${quoted}`], { encoding: "utf8" });
      expect(real.stdout).toBe(text);
    },
  );

  const isLocalHost = (h: string): boolean => h === "localhost";
  const PATHS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["docker exec", "docker", ["exec", "db", "psql", "-c"]],
    ["docker run", "docker", ["run", "--rm", "img", "psql", "-c"]],
    ["docker compose exec", "docker", ["compose", "exec", "-T", "db", "psql", "-c"]],
    ["podman exec", "podman", ["exec", "db", "psql", "-c"]],
    ["podman run", "podman", ["run", "img", "psql", "-c"]],
    ["ssh local", "ssh", ["localhost", "psql", "-c"]],
  ];
  for (const [label, prog, prefix] of PATHS) {
    it(`${label}: the text handed to the readers holds the word as typed`, () => {
      for (const text of TRICKY.filter((t) => t !== "")) {
        const texts = nestedTexts(prog, [...prefix, text], () => [], isLocalHost).map(
          (n) => n.text,
        );
        expect(texts.length, label).toBeGreaterThan(0);
        // at least one of the texts reads back to the original word as the last word (the quoted one; ssh also holds the joined text)
        const lastWords = texts.map((t) => words(t).at(-1));
        expect(lastWords, `${label} ${JSON.stringify(text)}: ${texts.join(" || ")}`).toContain(
          text,
        );
      }
    });
  }

  it("a single quote inside a SQL literal reaches the dblink and \\c readers behind every wrapper (R8-CR-3)", () => {
    for (const cmd of [
      `docker exec db psql -c "\\c 'host=${HOST} dbname=x'"`,
      `docker run img psql -c "\\c 'host=${HOST} dbname=x'"`,
      `docker exec db psql -c "select dblink_connect('host=${HOST} dbname=x')"`,
      `docker exec db psql -c "select * from dblink('host=${HOST} dbname=x','select 1') as t(a int)"`,
      `docker exec db mongosh --eval "connect('${HOST}')"`,
      `docker exec db psql -c "CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '${HOST}')"`,
      `ssh localhost psql -c "select dblink_connect('host=${HOST}')"`,
      `find . -name x -exec psql -c "select dblink_connect('host=${HOST}')" \\;`,
      `sudo -s psql -c "select dblink_connect('host=${HOST}')"`,
      `podman exec db psql -c "select dblink_connect('host=${HOST}')"`,
      `docker compose exec -T db psql -c "select dblink_connect('host=${HOST}')"`,
    ]) {
      expect(rank(cmd), cmd).toBe(2);
    }
  });

  it("the same strings with a local host stay allowed", () => {
    for (const cmd of [
      `docker exec db psql -c "select dblink_connect('host=localhost dbname=x')"`,
      `ssh localhost psql -c "select dblink_connect('host=localhost')"`,
      `docker exec db psql -c "select 'it''s'"`,
      `docker exec db psql -c "select * from t where a = 'x y'"`,
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});
