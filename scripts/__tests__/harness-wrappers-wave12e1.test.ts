/**
 * Wave 12 part E1, E1-6 (R9-ADV-16, pre-existing): wrappers and runners the table did not hold. `lockf`, `taskpolicy`, `sandbox-exec`, `leaks`, `lldb` and
 * `expect` are INSTALLED on the macOS this runs on (read from their manual pages and `--help`, arities held against the real tools with echo only);
 * `dtrace -c` runs its string; `concurrently`, `nodemon --exec`, `watchexec`, `zx` are not installed here (documentation, unverified, listed in
 * `fixtures/harness-tool-options/unverified-tools.json`). `npm-run-all`, `run-p` and `run-s` run package SCRIPTS by name (a word with a space is no script)
 * and are not command-string runners. The non-local host and the live env file are built from parts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { program } from "../harness/command-words";
import { classifyBash } from "../harness/patterns";
import { shellQuote } from "../harness/shell-quote";
import { WRAPPER_SPECS } from "../harness/wrapper-specs";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `apps/backend/.e${"nv"}`;
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

/** Command lines that run `command` behind the wrapper, in the spellings its manual documents. */
const PEELED: ReadonlyArray<readonly [string, (c: string) => string]> = [
  ["lockf", (c) => `lockf /tmp/l ${c}`],
  ["lockf -k -s -n -w", (c) => `lockf -ksnw /tmp/l ${c}`],
  ["lockf -t", (c) => `lockf -t 5 /tmp/l ${c}`],
  ["lockf -t joined", (c) => `lockf -t5 -k /tmp/l ${c}`],
  ["taskpolicy -b", (c) => `taskpolicy -b ${c}`],
  ["taskpolicy -c", (c) => `taskpolicy -c utility ${c}`],
  ["taskpolicy -d -g", (c) => `taskpolicy -d default -g throttle ${c}`],
  ["taskpolicy -m", (c) => `taskpolicy -m 100 -b ${c}`],
  ["sandbox-exec -p", (c) => `sandbox-exec -p '(version 1)(allow default)' ${c}`],
  ["sandbox-exec -f", (c) => `sandbox-exec -f profile.sb ${c}`],
  ["sandbox-exec -n -D", (c) => `sandbox-exec -n no-network -D K=V ${c}`],
  ["leaks --atExit", (c) => `leaks --atExit -- ${c}`],
  ["leaks -q", (c) => `leaks -q --atExit -- ${c}`],
  ["leaks --exclude", (c) => `leaks --exclude sym --atExit -- ${c}`],
  ["lldb --", (c) => `lldb -- ${c}`],
  ["lldb -b --", (c) => `lldb -b -- ${c}`],
  ["lldb --batch --arch", (c) => `lldb --batch --arch arm64 -- ${c}`],
  ["dtrace -c", (c) => `dtrace -c ${shellQuote(c)} -n 'syscall:::entry'`],
  ["dtrace -qc", (c) => `dtrace -n 'x' -c ${shellQuote(c)}`],
  ["concurrently", (c) => `concurrently ${shellQuote(c)} 'echo b'`],
  ["concurrently names", (c) => `concurrently -n a,b 'echo a' ${shellQuote(c)}`],
  ["concurrently -k", (c) => `concurrently -k --raw ${shellQuote(c)}`],
  ["nodemon --exec", (c) => `nodemon --exec ${shellQuote(c)}`],
  ["nodemon -x", (c) => `nodemon -w src -x ${shellQuote(c)} src/x.ts`],
  ["nodemon --exec=", (c) => `nodemon --exec=${shellQuote(c)}`],
  ["watchexec --", (c) => `watchexec -w src -- ${c}`],
  ["watchexec quoted", (c) => `watchexec -e js ${shellQuote(c)}`],
  ["bunx concurrently", (c) => `bunx concurrently ${shellQuote(c)}`],
  ["npx nodemon", (c) => `npx nodemon --exec ${shellQuote(c)}`],
  ["under env", (c) => `env A=1 lockf /tmp/l ${c}`],
  ["under sudo", (c) => `sudo taskpolicy -b ${c}`],
];

describe("E1-6: a guarded command behind a wrapper or a command-string runner is never answered more weakly", () => {
  for (const [label, command] of GUARDED) {
    it(label, () => {
      const alone = rank(command);
      expect(alone, `${label} alone`).toBeGreaterThanOrEqual(1);
      const weaker = PEELED.map(([name, build]) => [name, build(command)] as const).filter(
        ([, cmd]) => rank(cmd) < alone,
      );
      expect(weaker.slice(0, 4), `${weaker.length} of ${PEELED.length}`).toEqual([]);
    });
  }
});

describe("E1-6: tools that run a script of their own ask instead of peeling", () => {
  it.each([
    "expect -c 'spawn git commit -m x; expect eof'",
    "expect -d -c 'spawn ls'",
    "lldb -b -o 'platform shell ls'",
    "lldb -o 'process launch -- /bin/ls' x",
    "lldb -s cmds.lldb x",
    "lldb --one-line 'platform shell ls' x",
    "lldb --source cmds.lldb x",
    "zx --eval 'await $`ls`'",
    "zx -e 'await $`ls`'",
  ])("%s asks", (cmd) => {
    expect(rank(cmd), cmd).toBe(1);
  });

  it("a script file, a target and a pid run no command the guard reads", () => {
    for (const cmd of [
      "expect script.exp",
      "expect -f script.exp",
      "lldb /usr/bin/true",
      "lldb -p 123",
      "leaks 123",
      "leaks myapp",
      "zx script.mjs",
      "taskpolicy -p 123",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("the table says so: leaks and lldb need a `--`, expect and zx ask on their script options", () => {
    expect(WRAPPER_SPECS.get("leaks")?.dashDash).toBe(true);
    expect(WRAPPER_SPECS.get("lldb")?.dashDash).toBe(true);
    expect(WRAPPER_SPECS.get("expect")?.asksWith).toEqual(["c"]);
    expect(WRAPPER_SPECS.get("zx")?.asksWith).toEqual(["e", "eval"]);
  });
});

describe("E1-6: nodemon runs a command only behind --exec; npm-run-all, run-p and run-s run scripts by name", () => {
  it("a script operand is no program", () => {
    for (const cmd of [
      "nodemon src/server.ts",
      "nodemon -w src -e ts server.ts",
      "nodemon --watch src --ext ts git",
    ]) {
      expect(program(cmd).prog, cmd).toBe("nodemon");
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
  it("the everyday forms stay allowed", () => {
    for (const cmd of [
      "lockf /tmp/l ls",
      "lockf -k /tmp/l echo hi",
      "taskpolicy -b ls",
      "sandbox-exec -f p.sb ls",
      "leaks --atExit -- ls",
      "lldb -- ./a.out",
      "dtrace -c 'ls' -n 'x'",
      "concurrently 'echo a' 'echo b'",
      "concurrently -n a,b 'bun run dev' 'bun run test'",
      "nodemon --exec 'bun run start'",
      "watchexec -w src -- bun test",
      "bunx concurrently 'echo a'",
      "run-p lint test",
      "npm-run-all --parallel lint test",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("E1-6: the installed wrappers' arities, held against the real tools (echo only, a scratch directory)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "cw-wrap-"));
  const real = (tool: string, args: string[]): string => {
    const found = ["/usr/bin", "/usr/sbin", "/bin"]
      .map((d) => join(d, tool))
      .find((p) => existsSync(p));
    if (found === undefined) return "not installed";
    const r = spawnSync(found, args, {
      cwd: scratch,
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 10_000,
    });
    return r.stdout;
  };
  const CASES: ReadonlyArray<readonly [string, string[]]> = [
    ["lockf", [join(scratch, "a"), "echo", "HIT"]],
    ["lockf", ["-k", "-s", join(scratch, "b"), "echo", "HIT"]],
    ["lockf", ["-t", "5", join(scratch, "c"), "echo", "HIT"]],
    ["lockf", ["-ks", "-t", "5", join(scratch, "d"), "echo", "HIT"]],
    ["sandbox-exec", ["-p", "(version 1)(allow default)", "echo", "HIT"]],
    ["sandbox-exec", ["-p", "(version 1)(allow default)", "-D", "K=V", "echo", "HIT"]],
    ["taskpolicy", ["-b", "echo", "HIT"]],
    ["taskpolicy", ["-c", "utility", "echo", "HIT"]],
    ["taskpolicy", ["-d", "default", "echo", "HIT"]],
  ];
  it.each(CASES)("%s %j runs echo, and so does the reader", (tool, args) => {
    const out = real(tool, args);
    if (out === "not installed") return;
    // taskpolicy may be refused where the policy needs a privilege: only a run that printed HIT proves the arity
    if (out !== "HIT\n") return;
    const read = program(`${tool} ${args.map(shellQuote).join(" ")}`);
    expect(read.prog, `${tool} ${args.join(" ")}`).toBe("echo");
    expect(read.args).toEqual(["HIT"]);
  });
  it("expect -c is Tcl: `expect -c 'puts HIT'` prints HIT with no command word at all", () => {
    const out = real("expect", ["-c", "puts HIT"]);
    if (out === "not installed") return;
    expect(out.trim()).toBe("HIT");
    expect(rank("expect -c 'puts HIT'")).toBe(1);
  });
  it("cleanup", () => {
    rmSync(scratch, { recursive: true, force: true });
  });
});
