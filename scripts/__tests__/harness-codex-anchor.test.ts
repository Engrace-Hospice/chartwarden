/**
 * ADV-C3 (2026-11-10 adversarial review): the Codex hook used to find its script with
 * `$(git rev-parse --show-toplevel)`, which follows `core.worktree`. `git config core.worktree /tmp/x` (or a line
 * appended to `.git/config`) therefore made the hook run an attacker's `/tmp/x/scripts/harness/pre-tool-guard.ts`,
 * and two allowed commands switched the Codex guard off. The pinned command now walks up from the session
 * directory and reads no git configuration. Each test runs the REAL pinned command from `.codex/hooks.json`, with
 * a stub in place of the guard that prints which script ran.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scrubbedGitEnv } from "./helpers/scrubbed-env";

const ROOT = join(__dirname, "../..");
const HOOK: string = JSON.parse(readFileSync(join(ROOT, ".codex/hooks.json"), "utf8")).hooks
  .PreToolUse[0].hooks[0].command;

const made: string[] = [];
const scratch = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cw-anchor-")));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
/** The HOME every git call of this file runs with: empty, so no developer configuration reaches it. */
const GIT_HOME = scratch();

const stub = (marker: string): string =>
  `console.log(${JSON.stringify(marker)}, import.meta.dir);\n`;
const put = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const git = (cwd: string, ...args: string[]): void => {
  // Wave 12 (R9-COMP-10): a scratch HOME and no GIT_DIR / GIT_INDEX_FILE: a test run started from a git hook must not
  // add or commit to the REAL repository, nor a developer's gpgsign or template settings change this one.
  const r = spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=n", ...args], {
    cwd,
    env: scrubbedGitEnv(GIT_HOME),
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};

/** A repo shaped like the checkout: `.git`, the hook config and a stub in place of the guard. */
function checkout(marker = "REAL"): string {
  const dir = scratch();
  git(dir, "init", "-q", ".");
  put(join(dir, ".codex/hooks.json"), "{}\n");
  put(join(dir, "scripts/harness/pre-tool-guard.ts"), stub(marker));
  mkdirSync(join(dir, "apps/x"), { recursive: true });
  put(join(dir, "apps/x/keep"), "");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

/** The pinned command, run as Codex runs it: `sh -c`, from the session directory. */
const runHook = (cwd: string, env: Record<string, string> = {}) =>
  spawnSync("/bin/sh", ["-c", HOOK], {
    cwd,
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 20_000,
  });

describe("ADV-C3: the Codex hook finds its script without reading git configuration", () => {
  it("runs the checkout's script from the root and from a subdirectory", () => {
    const dir = checkout();
    for (const cwd of [dir, join(dir, "apps/x")]) {
      const r = runHook(cwd);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe(`REAL ${join(dir, "scripts/harness")}\n`);
    }
  });

  it("runs a linked worktree's own script (git worktree add), not the main checkout's", () => {
    const main = checkout("MAIN");
    const linked = join(scratch(), "wt");
    git(main, "worktree", "add", "-q", linked, "-b", "wt-branch");
    put(join(linked, "scripts/harness/pre-tool-guard.ts"), stub("LINKED"));
    mkdirSync(join(linked, "apps/x"), { recursive: true });
    const r = runHook(join(linked, "apps/x"));
    expect(r.stdout).toBe(`LINKED ${join(linked, "scripts/harness")}\n`);
  });

  it("follows a symlinked checkout to the real one", () => {
    const dir = checkout();
    const link = join(scratch(), "link");
    symlinkSync(dir, link);
    const r = runHook(join(link, "apps/x"));
    expect(r.stdout).toBe(`REAL ${join(dir, "scripts/harness")}\n`);
  });

  it("is not redirected by `git config core.worktree` (two allowed commands used to switch the guard off)", () => {
    const dir = checkout();
    const evil = scratch();
    put(join(evil, "scripts/harness/pre-tool-guard.ts"), stub("EVIL"));
    git(dir, "config", "core.worktree", evil);
    const r = runHook(dir);
    expect(r.stdout).toBe(`REAL ${join(dir, "scripts/harness")}\n`);
    expect(r.stdout).not.toContain("EVIL");
  });

  it("is not redirected by a `[core] worktree` line appended to .git/config", () => {
    const dir = checkout();
    const evil = scratch();
    put(join(evil, "scripts/harness/pre-tool-guard.ts"), stub("EVIL"));
    appendFileSync(join(dir, ".git/config"), `[core]\n\tworktree = ${evil}\n`);
    expect(runHook(dir).stdout).toBe(`REAL ${join(dir, "scripts/harness")}\n`);
  });

  it("is not redirected by a nested repo with only a stub script, below a session directory in the checkout", () => {
    const dir = checkout();
    const session = join(dir, "apps/x");
    git(session, "init", "-q", ".");
    put(join(session, "scripts/harness/pre-tool-guard.ts"), stub("EVIL"));
    expect(runHook(session).stdout).toBe(`REAL ${join(dir, "scripts/harness")}\n`);
  });

  it("refuses (exit 2, with the message) when no checkout holds the script", () => {
    const r = runHook(scratch());
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("the guard failed or timed out, so the call is refused");
  });

  it("refuses when a directory has .git and the script but no .codex/hooks.json (not the hook's own checkout)", () => {
    const dir = checkout();
    rmSync(join(dir, ".codex"), { recursive: true });
    expect(runHook(dir).status).toBe(2);
  });

  it("refuses when bun is not on PATH (a failed exec must not read as an allow)", () => {
    const dir = checkout();
    const bin = scratch();
    const perl = spawnSync("sh", ["-c", "command -v perl"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(perl, join(bin, "perl"));
    const r = runHook(dir, { PATH: bin });
    expect(r.status).toBe(2);
  });
});
