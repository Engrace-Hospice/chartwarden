/**
 * Wave 7, T5, CR5-1, CR5-2 and CR5-3 (round-5 code review, all CRITICAL; each allowed on the frozen tip).
 *
 * CR5-1: whitespace in a brace word is not a "quoted" signal. `{c,'x y'}` is an UNQUOTED group whose alternative holds a
 * quoted space, bash expands it, and the budget's cut left the real name (it needs a MIX of first and last alternatives)
 * unread, with no ask. Now the lexer says whether the command holds a group the shell would expand, the per-word cap is
 * the command's 4,096, and a brace-expanded destination of cp, mv, ln and install is every alternative, not the last.
 * CR5-2: the agent-hook variables (`PATH`, `SHELL`, …) were read one nesting level at a time, so `PATH=/tmp/x bash -c
 * 'claude -p hi'` allowed. CR5-3: one assignment grammar for real: sequences (`{E..E}`), `${NAME:=v}` and a name that
 * cannot be placed. `classifyBash` is pure: root, home and cwd are injected. Secret names are built from parts.
 */
import { describe, expect, it } from "vitest";
import { hasBareBraceGroup } from "../harness/bare-braces";
import { classifyBash } from "../harness/patterns";
import { assignments, hasUnplaceableName, shellWords } from "../harness/shell-assignments";
import { refillWork, work } from "../harness/work-budget";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const AWS = ["~/.", "aws", "/"].join("");
const G = `scripts/harness/hard-dead${"line.ts"}`;

/** `name` spelled with one two-way group per letter; `junk` is the filler alternative; `real`: real alternative first? */
function groups(
  name: string,
  junk: string,
  order: "alternate" | "real-first" | "junk-first",
): string {
  return [...name]
    .map((ch, i) => {
      const realFirst = order === "real-first" || (order === "alternate" && i % 2 === 0);
      return realFirst ? `{${ch},${junk}}` : `{${junk},${ch}}`;
    })
    .join("");
}

describe("hasBareBraceGroup: the lexer says whether the shell would expand a group", () => {
  it.each([
    "echo {a,b}",
    "cat x{a,b}y",
    "echo {1..3}",
    "echo {a..c}",
    "cat {c,'x y'}",
    'cat {c,"x y"}',
    "cat {c,x\\ y}",
    "echo '{a,b}' {c,d}",
  ])("%s: true", (cmd) => {
    expect(hasBareBraceGroup(cmd)).toBe(true);
  });
  it.each([
    "echo hello",
    "echo {a}",
    "echo {}",
    "echo '{a,b}'",
    'echo "{a,b}"',
    "echo \\{a,b\\}",
    `bun -e 'console.log({"a":1,"b":2})'`,
    `curl -d '{"a":1,"b":2}' http://localhost:3000`,
    "echo ${HOME}",
    "echo ${X:-a,b}",
    "echo {a..}",
  ])("%s: false", (cmd) => {
    expect(hasBareBraceGroup(cmd)).toBe(false);
  });
});

describe("CR5-1: a quoted or escaped space in an alternative is not a way past the budget", () => {
  const junks: Array<[string, string]> = [
    ["'x y'", "single-quoted space"],
    ['"x y"', "double-quoted space"],
    ["x\\ y", "backslash space"],
    ["x", "no space (the control)"],
  ];

  describe.each(junks)("junk alternative %s (%s)", (junk) => {
    it.each([
      ["alternate", 10],
      ["alternate", 11],
      ["real-first", 10],
      ["junk-first", 10],
      ["real-first", 11],
    ] as const)(
      "`cat` of a secret name spelled with %s order and %s groups is a deny",
      (order, n) => {
        // 10 and 11 two-way groups are 1,024 and 2,048 alternatives: inside the command's budget.
        const name = "credentials".slice(0, n);
        const cmd = `cat ${AWS}${groups(name, junk, order)}${"credentials".slice(n)}`;
        expect(d(cmd), cmd).toBe("deny");
      },
    );

    it("`cp` onto .claude/settings.json is an ask (a mix of first and last alternatives)", () => {
      const cmd = `cp /tmp/z .claude/${groups("settings.", junk, "alternate")}json`;
      expect(d(cmd), cmd).toBe("ask");
    });

    it("`cp` onto .gitleaks.toml is an ask", () => {
      const cmd = `cp /tmp/z ${groups(".gitleaks", junk, "alternate")}.toml`;
      expect(d(cmd), cmd).toBe("ask");
    });
  });

  it("past the command's own cap the answer is never an allow (a budget never turns an ask into an allow)", () => {
    const cmd = `cat ${AWS}${groups("credentials", "'x y'", "alternate")}${"{a,b}".repeat(14)}`;
    expect(d(cmd)).not.toBe("allow");
  });

  it("a budget never turns a deny into an ask: the all-junk name with 11 plain groups still denies", () => {
    expect(d(`cat ${AWS}${groups("credentials", "x", "alternate")}`)).toBe("deny");
  });

  it("an unquoted group the budget cuts asks; the same size quoted is not a finding", () => {
    expect(d(`echo ${"{a,b}".repeat(13)}`)).toBe("ask");
    expect(d(`echo '${"{a,b}".repeat(13)}'`)).toBe("allow");
    const json = `{"Statement":[{"Effect":"Allow","Action":["s3:GetObject"]}]}`;
    expect(d(`curl -d '${json.repeat(120)}' http://localhost:3000/x`)).toBe("allow");
    expect(d(`python3 -c "x = ${json.repeat(120)}"`)).toBe("allow");
  });

  it("a command whose braces are all quoted expands none of them (the budget is not spent on quoted text)", () => {
    // Real shape (a developer's `bun -e` over 3 KB with object literals, after a few `cd`s): 3 keys x 6 objects is 729
    // alternatives of 3 KB each, which spent the per-command resolution budget and asked when every group was expanded.
    const objects = Array.from(
      { length: 6 },
      (_, i) => `JSON.stringify({k${i}0: 0, k${i}1: 1, k${i}2: 2})`,
    ).join("; ");
    const script = `${objects}; // ${"x".repeat(3000)}`;
    expect(d(`cd /a; cd /b; cd /c; bun -e '${script}'`)).toBe("allow");
  });

  it("a cut word beside a bare group in the same command asks", () => {
    const big = `{"a":1,"b":2}`.repeat(400);
    expect(d(`python3 -c '${big}' {x,y}`)).toBe("ask");
  });
});

describe("the destination of cp, mv, ln and install is every alternative of the last argument", () => {
  it.each([
    "cp /tmp/z .claude/{settings.json,x}",
    "cp /tmp/z .claude/{x,settings.json}",
    "mv /tmp/z .claude/{settings.json,x}",
    "install /tmp/z .claude/{settings.json,x}",
    "ln -s /tmp/z .claude/{settings.json,x}",
    `cp /tmp/z scripts/harness/{x,hard-deadline.ts}`,
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });
  it.each([
    "cp a.ts{,.bak} scripts-old/",
    "cp /tmp/z src/{a,b}.ts",
    "mv src/{a,b}.ts /tmp/x/",
    "cp -r src/{a,b} /tmp/o",
  ])("everyday brace destinations stay allowed: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("CR5-2: an agent-hook variable assigned outside a nested command line still counts", () => {
  it.each([
    `PATH=/tmp/fakebin:$PATH bash -c 'claude -p "hi"'`,
    `export PATH=/tmp/fakebin:$PATH; bash -c 'claude -p hi'`,
    `env PATH=/tmp/fakebin:$PATH sh -c 'claude -p hi'`,
    `PATH=/tmp/fakebin:$PATH sh -c 'codex exec hi'`,
    `PATH=/tmp/fakebin:$PATH eval 'claude -p hi'`,
    `export PATH=/tmp/fakebin:$PATH; echo 'claude -p hi' | sh`,
    `SHELL=/tmp/x bash -c 'codex exec hi'`,
    `BASH_ENV=/tmp/x bash -c 'claude -p hi'`,
    `ZDOTDIR=/tmp/x zsh -c 'claude -p hi'`,
    `export LD_LIBRARY_PATH=/tmp/x; bash -c 'bunx claude -p hi'`,
    `PATH=/tmp/x bash -c "bash -c 'claude -p hi'"`,
    `PATH=/tmp/fakebin:$PATH claude -p hi`,
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });
  it.each([
    "PATH=/usr/bin:$PATH bash -c 'ls'",
    "export PATH=$HOME/bin:$PATH; bash -c 'git status'",
    "env PATH=/usr/bin sh -c 'bun run test'",
    "bash -c 'claude --version'",
    "bash -c 'echo claude'",
    "NODE_PATH=/x bash -c 'git log -1'",
    "claude --version",
  ])("neither a variable nor an agent alone asks: %s", (cmd) => {
    // `claude --version` and the like have no hook variable; a plain PATH change has no agent.
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("CR5-3: one assignment grammar", () => {
  it("shellWords expands comma groups and sequences", () => {
    expect(shellWords(["GIT_TRACE{2..2}"])).toEqual(["GIT_TRACE2"]);
    expect(shellWords(["A{1..3}"])).toEqual(["A1", "A2", "A3"]);
    expect(shellWords(["CODEX_HOM{E..E}"])).toEqual(["CODEX_HOME"]);
    expect(shellWords(["X{a..c}"])).toEqual(["Xa", "Xb", "Xc"]);
    expect(shellWords(["X{3..1}"])).toEqual(["X3", "X2", "X1"]);
    expect(shellWords(["X{1..7..3}"])).toEqual(["X1", "X4", "X7"]);
    expect(shellWords(["GIT_TRACE{,}"])).toEqual(["GIT_TRACE", "GIT_TRACE"]);
    expect(shellWords(["a\\ b"])).toEqual(["a b"]);
  });

  it("assignments reads ${NAME:=v} wherever it stands, and the sequence names", () => {
    expect(assignments(["${GIT_TRACE:=/x}"])).toEqual([{ name: "GIT_TRACE", value: "/x" }]);
    expect(assignments(["${GIT_TRACE=/x}"])).toEqual([{ name: "GIT_TRACE", value: "/x" }]);
    expect(assignments(['"${A:=1}"', "x${B:=2}y"]).map((a) => a.name)).toEqual(["A", "B"]);
    expect(assignments(["GIT_TRACE{2..2}=/x"])).toEqual([{ name: "GIT_TRACE2", value: "/x" }]);
    expect(assignments(["${GIT_TRACE:-/x}"])).toEqual([]);
    expect(assignments(["${GIT_TRACE}"])).toEqual([]);
  });

  it("hasUnplaceableName: a name that is still not a name after expansion", () => {
    expect(hasUnplaceableName(["${X}=v"])).toBe(true);
    expect(hasUnplaceableName(["$(echo GIT_TRACE)=v"])).toBe(true);
    expect(hasUnplaceableName(["A{b=v"])).toBe(true);
    expect(hasUnplaceableName(["GIT_TRACE=v", "PATH=$HOME/bin:$PATH", "-x", "NAME"])).toBe(false);
    expect(hasUnplaceableName(["A{b,c}=v"])).toBe(false);
  });

  it.each([
    `export GIT_TRACE=; : \${GIT_TRACE:=${G}}; git status`,
    `: \${GIT_TRACE2:=${G}}`,
    `export GIT_TRACE{2..2}=${G}; git status`,
    `export GIT_TRAC{E..E}=${G}; git status`,
    `export CODEX_HOM{E..E}=/tmp/x; codex exec hi`,
    `export CW_STOP_GAT{E..E}=off; claude -p hi`,
    `export CW_STOP_GAT{E,E}=off`,
    `export BUN_OPTION{S..S}=--preload=/tmp/x.js; claude -p hi`,
    `export BUN_OPTION{S..S}=--preload=/tmp/x.js`,
    `export PAGE{R..R}='rm scripts/harness/io.ts'; git log`,
    `: \${CODEX_HOME:=/tmp/x}`,
    `: \${CW_AGENT_LEDGER:=off}`,
    `echo \${HOME:=/tmp/x}`,
    `export \${X}=v; git status`,
    `export $(echo CODEX_HOME)=/tmp/x`,
    `declare -x CODEX_HOM{E..E}=/tmp/x`,
    `env GIT_TRACE{2..2}=${G} git status`,
    `read CODEX_HOM{E..E}`,
    `printf -v CODEX_HOM{E..E} x`,
  ])("asks: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "export GIT_TRACE=1; git status",
    "export GIT_TRACE=/tmp/trace.log; git status",
    "export GIT_TRACE2{,}=/tmp/x; git status",
    "export NAME{1..3}=x",
    "export PATH=$HOME/bin:$PATH",
    "export GIT_TRACE",
    "echo ${HOME}",
    "echo ${X:-fallback}",
    ": ${FOO:=bar}",
    "export A{1..3}=x B=${C:-d}",
    "echo CODEX_HOME=x",
  ])("everyday neighbour stays allowed: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("a sequence is bounded: a huge range does not run away", () => {
    refillWork(1000);
    expect(shellWords(["X{1..99999999}"]).length).toBeLessThanOrEqual(256);
    expect(work.spent).toBe(false);
  });
});
