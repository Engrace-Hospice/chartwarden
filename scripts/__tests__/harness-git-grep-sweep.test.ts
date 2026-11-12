/**
 * Wave 4, T2: `git grep --no-index` (and `--untracked --no-exclude-standard`) apply no .gitignore, so over a directory
 * that holds a live env file they read it, as `grep -r` does. Every ask below answered `allow` at the base of this
 * wave; the tracked-files-only forms next to them stay allowed.
 */
import { describe, expect, it } from "vitest";
import { gitGrepIgnoresGitignore } from "../harness/git-grep-sweep";
import { classifyBash } from "../harness/patterns";

/** A live env file's name, built so this file never spells it out. */
const BACKEND_ENV = ["apps/backend/", ".", "env"].join("");
const withEnv = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: (p: string) => p === `/repo/${BACKEND_ENV}`,
};
const noEnv = { ...withEnv, exists: () => false };
const v = (cmd: string, ctx: object = withEnv) => classifyBash(cmd, ctx);

describe("gitGrepIgnoresGitignore reads the flags the way git does", () => {
  it.each<[string[], boolean]>([
    [["--no-index", "foo"], true],
    [["foo", "--no-index", "apps"], true],
    [["--no-ind", "foo"], true],
    [["--no-in", "foo"], true],
    [["--untracked", "--no-exclude-standard", "foo"], true],
    [["--no-exclude-standard", "--untracked", "foo"], true],
    [["--no-index", "--exclude-standard", "--no-exclude-standard", "foo"], true],
    [["--no-index", "--no-exclude-standard", "foo"], true],
    [["--untracked", "foo"], false],
    [["--no-index", "--exclude-standard", "foo"], false],
    [["--no-index", "--no-exclude-standard", "--exclude-standard", "foo"], false],
    [["--untracked", "--exclude-standard", "foo"], false],
    [["--no-exclude-standard", "foo"], false],
    [["-n", "foo", "--", "--no-index"], false],
    [["-e", "--no-index", "scripts"], false],
    [["foo", "scripts"], false],
    [["--cached", "foo"], false],
    [["--no-ignore-case", "foo"], false],
  ])("%j -> %s", (rest, expected) => {
    expect(gitGrepIgnoresGitignore(rest)).toBe(expected);
  });
});

describe("git grep without .gitignore is judged like `grep -r` over the same directory", () => {
  it.each([
    "git grep --no-index foo",
    "git grep --no-index foo apps",
    "git grep --no-index foo apps/backend",
    "git grep -n --no-index -e KEY apps/backend",
    "git grep --no-ind foo apps",
    "git grep --untracked --no-exclude-standard foo apps",
    "git grep --no-exclude-standard --untracked foo apps",
    "git grep --no-index --exclude-standard --no-exclude-standard foo apps",
    "git -C apps/backend grep --no-index KEY",
    "git -C apps grep --no-index KEY backend",
    "cd apps/backend && git grep --no-index KEY",
    "cd apps && git grep --no-index KEY backend",
    "git --no-pager grep --no-index KEY apps",
  ])("asks about %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, cmd).toBe("ask");
    expect(verdict.reason).toMatch(/git grep/);
  });

  it.each([
    "git grep foo scripts",
    "git grep -n foo -- scripts/harness",
    "git grep --untracked foo scripts",
    "git grep --untracked foo apps",
    "git grep --no-index --exclude-standard foo scripts",
    "git grep --no-index --exclude-standard foo apps",
    "git grep --no-index foo scripts",
    "git grep --no-index foo -- scripts/harness",
    "git grep -e --no-index apps",
    "git grep foo apps",
    "git grep -n KEY apps/backend/src",
    "git grep foo HEAD -- apps",
  ])("allows the everyday %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, `${cmd}: ${verdict.reason}`).toBe("allow");
  });

  it("asks over the repo root without looking for a file, as grep -r does; elsewhere only where a live env file exists", () => {
    expect(v("git grep --no-index foo", noEnv).decision).toBe("ask");
    expect(v("git grep --no-index foo apps", noEnv).decision).toBe("allow");
    expect(v("git grep --no-index foo apps").decision).toBe("ask");
  });

  it("keeps agreeing with `grep -r` and `rg -u`, which it was modelled on", () => {
    expect(v("grep -r foo apps").decision).toBe("ask");
    expect(v("rg -u foo apps").decision).toBe("ask");
    expect(v("rg foo apps").decision).toBe("allow");
  });
});
