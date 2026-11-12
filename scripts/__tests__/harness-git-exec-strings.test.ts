/**
 * Wave 4, T1: command lines that git, and the variables it honours, hand to a shell. `git rebase -x 'rm …'`,
 * `git submodule foreach`, `git bisect run`, `git difftool -x`, `git filter-branch --tree-filter`, `git grep -O`,
 * `git instaweb --httpd` and `--upload-pack` all ran a string outside the classifier, and `EDITOR='…'`, `PAGER='…'`
 * did too; `GIT_CONFIG_KEY_n` injected an exec-capable config key that `git -c` denies. Each payload under an
 * "asks" or "denies" heading answered `allow` at the base of this wave; every one has an everyday neighbour that
 * must stay allowed. `classifyBash` is pure: root, home and cwd are injected, and every path "exists".
 */
import { describe, expect, it } from "vitest";
import {
  assignmentWords,
  envCommandStrings,
  gitCommandStrings,
  gitEnvConfigs,
  gitEnvVerdict,
  isGitRerootOption,
} from "../harness/git-exec-strings";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const v = (cmd: string) => classifyBash(cmd, ctx);
const d = (cmd: string) => v(cmd).decision;
/** A live env file's name, built so this file never spells it out. */
const ENV = ["apps/backend/", ".", "env"].join("");
const RM = "rm scripts/harness/pre-tool-guard.ts";

describe("gitCommandStrings: the table of git options and subcommands that carry a command line", () => {
  it.each<[string, string[], string[]]>([
    ["rebase", ["-x", "make test", "HEAD~3"], ["make test"]],
    ["rebase", ["--exec", "make test", "HEAD~3"], ["make test"]],
    ["rebase", ["--exec=make test", "HEAD~3"], ["make test"]],
    ["rebase", ["-xmake", "HEAD~3"], ["make"]],
    ["rebase", ["-ix", "make test", "HEAD~3"], ["make test"]],
    ["rebase", ["-x", "a", "-x", "b"], ["a", "b"]],
    ["difftool", ["-x", "meld", "HEAD~1"], ["meld"]],
    ["difftool", ["--extcmd=meld", "HEAD~1"], ["meld"]],
    ["filter-branch", ["--tree-filter", "rm x", "HEAD"], ["rm x"]],
    ["filter-branch", ["--index-filter=rm x", "HEAD"], ["rm x"]],
    ["filter-branch", ["--msg-filter", "cat", "--env-filter", "true", "HEAD"], ["cat", "true"]],
    [
      "filter-branch",
      ["--commit-filter", "git commit-tree", "--tag-name-filter", "cat"],
      ["git commit-tree", "cat"],
    ],
    ["filter-branch", ["--parent-filter", "sed s/a/b/"], ["sed s/a/b/"]],
    ["instaweb", ["--httpd=lighttpd"], ["lighttpd"]],
    ["instaweb", ["-d", "lighttpd", "-b", "open"], ["lighttpd", "open"]],
    ["fetch", ["--upload-pack", "cmd", "/path"], ["cmd"]],
    ["fetch", ["--upload-pack=cmd", "/path"], ["cmd"]],
    ["pull", ["--upload-pack=cmd", "/path"], ["cmd"]],
    ["clone", ["-u", "cmd", "/src", "/dst"], ["cmd"]],
    ["clone", ["--upload-pack=cmd", "/src", "/dst"], ["cmd"]],
    ["ls-remote", ["--exec=cmd", "/src"], ["cmd"]],
    ["ls-remote", ["--upload-pack", "cmd", "/src"], ["cmd"]],
    ["push", ["--receive-pack=cmd", "/dst", "main"], ["cmd"]],
    ["push", ["--exec", "cmd", "/dst"], ["cmd"]],
    ["archive", ["--remote=/src", "--exec=cmd", "HEAD"], ["cmd"]],
    ["grep", ["-Orm x", "foo"], ["rm x"]],
    ["grep", ["-nOrm x", "foo"], ["rm x"]],
    ["grep", ["--open-files-in-pager=rm x", "foo"], ["rm x"]],
    ["grep", ["--open=rm x", "foo"], ["rm x"]],
    ["submodule", ["foreach", "rm x"], ["rm x"]],
    ["submodule", ["foreach", "--recursive", "rm x"], ["rm x"]],
    ["submodule", ["--quiet", "foreach", "--recursive", "git", "status"], ["git status"]],
    ["bisect", ["run", "rm", "x"], ["rm x"]],
    ["bisect", ["run", "sh", "-c", "rm x"], ["sh -c 'rm x'"]],
  ])("git %s %j carries %j", (sub, rest, expected) => {
    expect(gitCommandStrings(sub, rest)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ["rebase", ["--onto", "main", "HEAD~3"]],
    ["rebase", ["-i", "HEAD~3"]],
    ["fetch", ["origin"]],
    ["fetch", ["-u", "origin"]], // `-u` is --update-head-ok on fetch, not --upload-pack
    ["grep", ["-n", "foo", "scripts"]],
    ["grep", ["-e", "-Orm x", "scripts"]], // a pattern, not an option
    ["grep", ["--open-files-in-pager", "foo"]], // no `=`: the default pager
    ["grep", ["foo", "--", "-Ox"]],
    ["submodule", ["update", "--init"]],
    ["submodule", ["foreach"]],
    ["bisect", ["start"]],
    ["bisect", ["run"]],
    ["log", ["-x", "y"]],
    ["status", []],
  ])("git %s %j carries none", (sub, rest) => {
    expect(gitCommandStrings(sub, rest)).toEqual([]);
  });
});

describe("environment variables that carry a command line or git config", () => {
  it("reads the command-line variables from the prefix assignments, and from export's arguments", () => {
    expect(
      envCommandStrings(["EDITOR=rm x", "FOO=bar", "PAGER=less -R", "GIT_ASKPASS=true"]),
    ).toEqual(["rm x", "less -R", "true"]);
    expect(envCommandStrings(["EDITOR=", "VISUAL=  "])).toEqual([]);
    expect(assignmentWords("export", ["EDITOR=vim"], ["A=1"])).toEqual(["A=1", "EDITOR=vim"]);
    expect(assignmentWords("git", ["status"], ["A=1"])).toEqual(["A=1"]);
  });

  it("turns GIT_CONFIG_KEY_n / VALUE_n and GIT_CONFIG_PARAMETERS into `key=value`, as `git -c` writes them", () => {
    expect(
      gitEnvConfigs([
        "GIT_CONFIG_COUNT=2",
        "GIT_CONFIG_KEY_0=core.pager",
        "GIT_CONFIG_VALUE_0=x",
        "GIT_CONFIG_KEY_1=color.ui",
      ]),
    ).toEqual(["core.pager=x", "color.ui="]);
    expect(
      gitEnvConfigs(["GIT_CONFIG_PARAMETERS='core.fsmonitor=rm x' 'color.ui=always'"]),
    ).toEqual(["core.fsmonitor=rm x", "color.ui=always"]);
    expect(gitEnvConfigs(["GIT_CONFIG_PARAMETERS='core.fsmonitor'='rm x'"])).toEqual([
      "core.fsmonitor=rm x",
    ]);
  });

  it("denies an exec-capable injected key, asks about a re-rooting variable, and has no opinion on the rest", () => {
    expect(
      gitEnvVerdict(["GIT_CONFIG_KEY_0=core.fsmonitor", "GIT_CONFIG_VALUE_0=x"])?.decision,
    ).toBe("deny");
    expect(gitEnvVerdict(["GIT_CONFIG_PARAMETERS='alias.x=!rm y'"])?.decision).toBe("deny");
    for (const name of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_EXEC_PATH",
      "GIT_TEMPLATE_DIR",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_ALLOW_PROTOCOL",
    ]) {
      expect(gitEnvVerdict([`${name}=/tmp/x`])?.decision, name).toBe("ask");
    }
    expect(gitEnvVerdict(["GIT_CONFIG_KEY_0=color.ui", "GIT_CONFIG_VALUE_0=always"])).toBeNull();
    expect(gitEnvVerdict(["GIT_AUTHOR_NAME=x", "FOO=1"])).toBeNull();
  });

  it("knows which global options re-point git", () => {
    expect(["--git-dir", "--git-dir=/x", "--exec-path=/x"].every(isGitRerootOption)).toBe(true);
    expect(["--exec-path", "--work-tree=/x", "-C", "--no-pager"].some(isGitRerootOption)).toBe(
      false,
    );
  });
});

describe("a command string handed to a shell by git is judged as a command line", () => {
  it.each([
    `git grep -O'${RM}' foo`,
    `git grep --open-files-in-pager='${RM}' foo`,
    `git submodule foreach '${RM}'`,
    `git submodule foreach --recursive '${RM}'`,
    `git rebase -x '${RM}' HEAD~1`,
    `git rebase --exec '${RM}' HEAD~1`,
    `git rebase -i -x '${RM}' HEAD~1`,
    `git bisect run ${RM}`,
    `git bisect run sh -c '${RM}'`,
    `git difftool -x '${RM}' HEAD~1`,
    `git difftool --extcmd='${RM}' HEAD~1`,
    `git filter-branch --tree-filter '${RM}' HEAD`,
    `git filter-branch --index-filter '${RM}' HEAD`,
    `git filter-branch --msg-filter '${RM}' HEAD`,
    `git filter-branch --env-filter '${RM}' HEAD`,
    `git filter-branch --commit-filter '${RM}' HEAD`,
    `git filter-branch --parent-filter '${RM}' HEAD`,
    `git filter-branch --tag-name-filter '${RM}' HEAD`,
    `git instaweb --httpd='${RM}'`,
    `git fetch --upload-pack='${RM}' /tmp/repo`,
    `git fetch --upload-pack '${RM}' /tmp/repo`,
    `git pull --upload-pack='${RM}' /tmp/repo`,
    `git clone -u '${RM}' /tmp/repo /tmp/x`,
    `git clone --upload-pack='${RM}' /tmp/repo /tmp/x`,
    `git ls-remote --upload-pack='${RM}' /tmp/repo`,
    `git ls-remote --exec='${RM}' /tmp/repo`,
    `git push --receive-pack='${RM}' /tmp/repo feature`,
    `git push --exec='${RM}' /tmp/repo feature`,
    `git archive --remote=/tmp/repo --exec='${RM}' HEAD`,
  ])("asks about %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    [`git rebase -x 'cat ${ENV}' HEAD~1`],
    [`git submodule foreach 'cat ${ENV}'`],
    [`git bisect run cat ${ENV}`],
    [`git difftool -x 'cat ${ENV}' HEAD~1`],
    [`git filter-branch --tree-filter 'cat ${ENV}' HEAD`],
    [`git fetch --upload-pack='cat ${ENV}' /tmp/repo`],
  ])("denies %s: the string reads a live secret file", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });

  it("judges the string where git runs: under `git -C dir`, a relative path is the dir's", () => {
    expect(d("git -C scripts rebase -x 'rm harness/pre-tool-guard.ts' HEAD~1")).toBe("ask");
    expect(d("git rebase -x 'rm harness/pre-tool-guard.ts' HEAD~1")).toBe("allow");
  });

  it("judges a string that nests another (`sh -c`, a pipe) like any command line", () => {
    expect(d(`git rebase -x 'sh -c "${RM}"' HEAD~1`)).toBe("ask");
    expect(d(`git submodule foreach 'git status; ${RM}'`)).toBe("ask");
  });

  it.each([
    "git rebase -x 'bun run test' HEAD~3",
    "git rebase --exec 'bun run typecheck && bun run test' main",
    "git submodule foreach 'git status'",
    "git submodule foreach --recursive 'git fetch'",
    "git bisect run bun test",
    "git bisect run sh -c 'bun run test'",
    "git bisect start HEAD HEAD~20",
    "git filter-branch --tree-filter 'true' HEAD",
    "git filter-branch --msg-filter 'sed s/a/b/' HEAD",
    "git difftool -x 'diff -u' HEAD~1",
    "git grep -O less foo",
    "git grep -n foo scripts",
    "git fetch --upload-pack=git-upload-pack origin",
    "git fetch origin",
    "git clone https://github.com/x/y.git /tmp/y",
    "git push origin feature",
    "git rebase -i HEAD~3",
  ])("allows the everyday %s", (cmd) => {
    expect(v(cmd).decision, `${cmd}: ${v(cmd).reason}`).toBe("allow");
  });
});

describe("a command line carried by an environment variable is judged", () => {
  it.each([
    `EDITOR='${RM}' git commit`,
    `VISUAL='${RM}' git commit`,
    `PAGER='${RM}' git log`,
    `SSH_ASKPASS='${RM}' ssh localhost`,
    `env EDITOR='${RM}' git commit`,
    `export EDITOR='${RM}'; git commit`,
    `GIT_SSH_COMMAND='${RM}' git fetch origin`,
    `GIT_PROXY_COMMAND='${RM}' git fetch origin`,
    `GIT_EXTERNAL_DIFF='${RM}' git diff`,
    `GIT_PAGER='${RM}' git log`,
    `GIT_EDITOR='${RM}' git commit`,
    `GIT_SEQUENCE_EDITOR='${RM}' git rebase -i HEAD~2`,
    `GIT_ASKPASS='${RM}' git fetch`,
  ])("asks about %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("denies a value that reads a live secret file, which the prefix's own ask could not", () => {
    expect(d(`PAGER='cat ${ENV}' git log`)).toBe("deny");
    expect(d(`GIT_PAGER='cat ${ENV}' git log`)).toBe("deny");
    expect(d(`export EDITOR='cat ${ENV}'`)).toBe("deny");
  });

  it.each([
    "EDITOR=vim git commit",
    "VISUAL='code --wait' git commit",
    "PAGER=cat git log",
    "PAGER='less -R' git diff",
    "export EDITOR=vim",
    "FOO=1 git status",
  ])("allows the everyday %s", (cmd) => {
    expect(v(cmd).decision, `${cmd}: ${v(cmd).reason}`).toBe("allow");
  });
});

describe("config injected through the environment is denied exactly as `git -c` is", () => {
  it.each([
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0='true' git status",
    "env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='!sh' git x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.sshCommand GIT_CONFIG_VALUE_0=x git fetch",
    `GIT_CONFIG_PARAMETERS="'core.fsmonitor=true'" git status`,
    `GIT_CONFIG_PARAMETERS="'core.fsmonitor'='true'" git status`,
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=x bun run test",
    "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null; git commit -m x",
  ])("denies %s", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });

  it("does not deny a presentation-only key, and git -c still agrees", () => {
    expect(
      d("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=always git status"),
    ).not.toBe("deny");
    expect(d("git -c core.fsmonitor=true status")).toBe("deny");
  });
});

describe("a variable or option that re-points git asks", () => {
  it.each([
    "GIT_DIR=/tmp/x git status",
    "GIT_WORK_TREE=/tmp/x git status",
    "GIT_EXEC_PATH=/tmp/x git status",
    "GIT_TEMPLATE_DIR=/tmp/x git init",
    "GIT_CONFIG_GLOBAL=/tmp/x git status",
    "GIT_CONFIG_SYSTEM=/tmp/x git status",
    "export GIT_DIR=/tmp/x; git status",
    "GIT_DIR=/tmp/x bun run test",
    "git --git-dir=/tmp/x status",
    "git --git-dir /tmp/x status",
    "git --exec-path=/tmp/x status",
  ])("asks about %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "git --no-pager log -1",
    "git --exec-path",
    "git -C scripts status",
    "git status --short",
    "git commit -m x",
  ])("allows the everyday %s", (cmd) => {
    expect(v(cmd).decision, `${cmd}: ${v(cmd).reason}`).toBe("allow");
  });
});

describe("an `ext::` remote URL, and the config that lets it run", () => {
  it.each([
    "git clone 'ext::sh -c true' /tmp/x",
    "git ls-remote ext::true",
    "git fetch 'EXT::true'",
    "git remote add o 'ext::sh -c true'",
  ])("asks about %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "git config protocol.allow always",
    "git config --global protocol.allow always",
    "git -c protocol.allow=always clone https://example.com/a.git /tmp/y",
    "git config protocol.ext.allow always",
  ])("denies %s: git refuses ext unless its policy is set", (cmd) => {
    expect(d(cmd), cmd).toBe("deny");
  });

  it.each([
    "git clone https://github.com/a/b.git /tmp/b",
    "git config --get protocol.allow",
    "git config protocol.version 2",
    "git -c protocol.file.allow=always submodule update --init",
  ])("does not deny the everyday %s", (cmd) => {
    expect(d(cmd), cmd).not.toBe("deny");
  });
});
