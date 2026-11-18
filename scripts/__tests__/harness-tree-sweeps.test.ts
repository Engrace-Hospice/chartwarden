/**
 * Wave 6, T3 (round-4 adversarial ADV-4 and ADV-5). `git diff --no-index DIR DIR` and `diff -r` print every file under
 * a directory, a live env file included, as `grep -r` does, and nothing asked; `git grep --no-index`'s directory-sweep
 * ask was defeated by pathspec magic (`:/apps`, `:(glob)apps/**`), a glob (`'apps/*'`), `..` and `~`. Now every
 * command that reads a whole tree asks when an operand is the repo root, a directory that holds a live env file that
 * EXISTS, a directory above the root, or cannot be placed (an unresolvable `cd`, a glob that could match such a
 * directory, pathspec magic). Every ask below answered `allow` at the base of this wave; each has an everyday
 * neighbour that must stay allowed. `classifyBash` is pure: root, home, cwd and "exists" are injected.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { globReachesLiveEnv, holdsLiveEnvDirectly } from "../harness/secret-reads";
import { diffSweepOperands, gitDiffSweepOperands } from "../harness/tree-sweep";

/** A live env file's name, built so this file never spells it out. */
const BACKEND_ENV = ["apps/backend/", ".", "env"].join("");
const withEnv = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: (p: string) => p === `/repo/${BACKEND_ENV}`,
};
const noEnv = { ...withEnv, exists: () => false };
const d = (cmd: string, ctx: object = withEnv) => classifyBash(cmd, ctx).decision;
const exists = (p: string) => p === BACKEND_ENV;
/** The repo under the home directory, as on a developer machine: `~` and `~/Apps` are above it. */
const underHome = {
  root: "/Users/dev/Apps/repo",
  home: "/Users/dev",
  cwd: "/Users/dev/Apps/repo",
  exists: (p: string) => p === `/Users/dev/Apps/repo/${BACKEND_ENV}`,
};

describe("globReachesLiveEnv and holdsLiveEnvDirectly (secret-reads.ts)", () => {
  it.each<[string, boolean]>([
    ["apps/*", true],
    ["apps/**", true],
    ["apps/b*", true],
    ["apps/*/.env", true],
    ["*", true],
    ["a*", true],
    ["apps/backend/.e*", true],
    ["?pps", true],
    ["scripts/*", false],
    ["scripts/*.ts", false],
    ["apps/web/*", false],
    ["docs/**", false],
    ["*.md", false],
    ["**/*.ts", false],
  ])("glob %s reaches the live env file: %s", (glob, expected) => {
    expect(globReachesLiveEnv(glob, exists)).toBe(expected);
    expect(globReachesLiveEnv(glob, () => false)).toBe(false);
  });
  it.each<[string, boolean]>([
    ["apps/backend", true],
    ["apps/backend/", true],
    ["apps", false],
    ["", false],
    ["apps/web", false],
  ])("directory %j holds one directly: %s", (dir, expected) => {
    expect(holdsLiveEnvDirectly(dir, exists)).toBe(expected);
  });
  it("the repo root holds the root-level file directly", () => {
    expect(holdsLiveEnvDirectly("", (f) => f === ".env")).toBe(true);
  });
});

describe("diffSweepOperands (diff, colordiff)", () => {
  it.each<[string, string[], string[] | null, "tree" | "children" | null]>([
    ["diff", ["-r", "a", "b"], ["a", "b"], "tree"],
    ["diff", ["-ru", "a", "b"], ["a", "b"], "tree"],
    ["diff", ["-rq", "a", "b"], ["a", "b"], "tree"],
    ["diff", ["-Nr", "a", "b"], ["a", "b"], "tree"],
    ["diff", ["-R", "a", "b"], ["a", "b"], "tree"],
    ["diff", ["--recursive", "a", "b"], ["a", "b"], "tree"],
    ["diff", ["--rec", "a", "b"], ["a", "b"], "tree"],
    ["diff", ["-u", "-r", "a", "b"], ["a", "b"], "tree"],
    ["colordiff", ["-r", "a", "b"], ["a", "b"], "tree"],
    ["diff", ["-u", "a", "b"], ["a", "b"], "children"],
    ["diff", ["a", "b"], ["a", "b"], "children"],
    ["colordiff", ["-u", "a", "b"], ["a", "b"], "children"],
    ["diff", ["-r", "--", "a", "b"], ["a", "b"], "tree"],
    ["diff", ["--", "-r", "b"], ["-r", "b"], "children"],
    ["diff", ["-r", "a", "-"], ["a"], "tree"],
    ["diff", ["<(git", "-C", "/repo", "show", "HEAD:x)", "y"], ["y"], "children"],
    ["diff", ["-r", "<(ls", "a)", ">(cat", "-n)", "b"], ["b"], "tree"],
    ["diff", ["<(echo", "$(pwd))", "y"], ["y"], "children"],
    ["git", ["status"], null, null],
    ["cmp", ["a", "b"], null, null],
    ["diff3", ["a", "b", "c"], null, null],
  ])("%s %j", (prog, args, operands, mode) => {
    const got = diffSweepOperands(prog, args);
    expect(got?.operands ?? null).toEqual(operands);
    expect(got?.mode ?? null).toEqual(mode);
  });
});

describe("gitDiffSweepOperands (git diff)", () => {
  it.each<[string[], string[] | null, boolean]>([
    [["--no-index", "a", "b"], ["a", "b"], true],
    [["--no-index", "--", "a", "b"], ["a", "b"], true],
    [["--no-ind", "a", "b"], ["a", "b"], true],
    [["--stat", "--no-index", "a", "b"], ["a", "b"], true],
    [["a", "b"], ["a", "b"], false],
    [["--", "a", "b"], ["a", "b"], false],
    [["HEAD~1"], null, false],
    [[], null, false],
    [["--stat"], null, false],
    [["a", "b", "c"], null, false],
    [["HEAD", "--", "a", "b"], null, false],
    [["main...HEAD", "--", "../"], null, false],
    [["--stat", "main", "--", "a"], null, false],
    [["--no-index", "main", "--", "a"], ["main", "a"], true],
    [["--cached", "a", "b"], ["a", "b"], false],
  ])("%j", (rest, operands, noIndex) => {
    const got = gitDiffSweepOperands(rest);
    expect(got?.operands ?? null).toEqual(operands);
    expect(got?.noIndex ?? false).toBe(noIndex);
  });
});

describe("ADV-4: a recursive diff of a directory that holds a live env file asks", () => {
  it.each([
    // The reviewer's four repros.
    "git diff --no-index apps/web apps/backend",
    "git diff --no-index /var/empty apps/backend",
    "diff -r /var/empty apps/backend",
    "diff -ru apps/web apps/backend",
    // Operand order, separators, abbreviations.
    "git diff --no-index apps/backend /var/empty",
    "git diff --no-index -- /var/empty apps/backend",
    "git diff --no-index --stat apps/backend /tmp/x",
    "git diff --no-ind /var/empty apps/backend",
    "git diff --no-index --name-only /tmp/x apps",
    "git diff --no-index /tmp/x apps/",
    "git diff --no-index /tmp/x ./apps",
    "git diff --no-index /tmp/x scripts/../apps",
    "git -C apps diff --no-index /tmp/x backend",
    "cd apps && git diff --no-index /tmp/x backend",
    // The implied no-index: two operands, one of them outside the working tree.
    "git diff /var/empty apps/backend",
    "git diff apps/backend /var/empty",
    "git diff -- /var/empty apps/backend",
    "git diff ~/x apps/backend",
    "git diff ../x apps/backend",
    // The root, and what is above it.
    "git diff --no-index /tmp/x .",
    "git diff --no-index /tmp/x ./",
    "git diff --no-index /tmp/x ..",
    "git diff --no-index /tmp/x ~",
    "git diff --no-index /tmp/x /",
    "git diff --no-index /tmp/x /repo",
    // diff, colordiff
    "diff -r apps/web apps/backend",
    "diff -rq apps/web apps/backend",
    "diff -Nr /var/empty apps",
    "diff -R /var/empty apps",
    "diff --recursive /var/empty apps",
    "diff --rec /var/empty apps",
    "diff -r -u /var/empty apps",
    "diff -r /tmp/x .",
    "diff -r /tmp/x ..",
    "diff -r /tmp/x ~",
    "diff -r /tmp/x /repo",
    "diff -r --exclude=node_modules /tmp/x apps",
    "colordiff -r /var/empty apps/backend",
    "colordiff -ru /var/empty apps",
    "cd apps && diff -r /tmp/x backend",
    // A glob the shell expands, a place that cannot be named.
    "diff -r /tmp/x apps/*",
    "diff -r /tmp/x 'apps/*'",
    "diff -r /tmp/x apps/b*",
    "git diff --no-index /tmp/x 'apps/*'",
    "git diff --no-index /tmp/x apps/?ackend",
    "cd /somewhere/we/cannot/follow$X && diff -r /tmp/x y",
    // Not recursive, but `diff DIR DIR` compares the same-named files in both, and `-N` any file.
    "diff apps/backend /tmp/copy",
    "diff -N /var/empty apps/backend",
    "diff -u /tmp/x apps/backend",
  ])("asks: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "diff a.txt b.txt",
    "diff -u a.txt b.txt",
    "diff -u scripts/a.ts /tmp/a.ts",
    "diff -r dir1 dir2",
    "diff -r scripts /tmp/scripts-copy",
    "diff -ru docs/a docs/b",
    "diff -rq packages/ui /tmp/ui",
    "diff -r --exclude=node_modules apps/web /tmp/web",
    "diff -r apps/web/src /tmp/src",
    "diff -r /tmp/a /tmp/b",
    "diff -r ~/Downloads/a ~/Downloads/b",
    "diff -r scripts/* /tmp/x",
    "colordiff -u a.txt b.txt",
    "colordiff -r dir1 dir2",
    // `diff` of two directories compares same-named FILES only, so a parent that does not hold one directly is fine.
    "diff apps /tmp/x",
    "diff docs/a docs/b",
    "diff <(sort a) <(sort b)",
    "diff <(git -C /repo show HEAD:docker-compose.yml) docker-compose.yml",
    "diff <(git -C . show HEAD:a.yml) b.yml",
    "cmp a.txt b.txt",
    "cmp apps apps/web",
    "git diff",
    "git diff HEAD~1",
    "git diff HEAD~1 HEAD",
    "git diff main..feature",
    "git diff abc1234 def5678",
    "git diff --stat",
    "git diff --cached",
    "git diff HEAD~1 -- scripts/harness",
    "git diff a.txt b.txt",
    "git diff --no-index a.txt b.txt",
    "git diff --no-index scripts/a.ts /tmp/a.ts",
    "git diff --no-index dir1 dir2",
    "git diff --no-index /tmp/a /tmp/b",
    "git diff --no-index scripts /tmp/scripts-copy",
    "git diff apps/web apps/admin",
    "git diff /tmp/a /tmp/b",
    "git diff ../other-branch HEAD",
    "git diff origin/main...HEAD -- ../",
    "git diff HEAD -- /var/empty",
    "git diff main -- apps/backend",
    "git diff --no-index apps/web/src /tmp/src",
  ])("allows: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("with no live env file on disk, the same commands are everyday", () => {
    for (const cmd of [
      "git diff --no-index apps/web apps/backend",
      "git diff --no-index /var/empty apps/backend",
      "diff -r /var/empty apps/backend",
      "diff -ru apps/web apps/backend",
      "diff -N /var/empty apps/backend",
    ]) {
      expect(d(cmd, noEnv), cmd).toBe("allow");
    }
  });

  it("names the diff and the way out", () => {
    const v = classifyBash("diff -r /var/empty apps/backend", withEnv);
    expect(v.reason).toMatch(/diff/);
    expect(v.reason).toMatch(/live \.env/);
  });

  it("a protected-path deny in the same command line still wins", () => {
    expect(d("diff -r /tmp/x apps; cat apps/backend/.env")).toBe("deny");
  });
});

describe("ADV-5: git grep --no-index cannot be steered off a directory that holds a live env file", () => {
  it.each([
    // The reviewer's repros.
    "git grep --no-index -l SECRET -- 'apps/*'",
    "git grep --no-index -l SECRET -- ':(glob)apps/**'",
    "git grep --no-index -l SECRET :/apps",
    "git grep --no-index -l SECRET -- ..",
    "git grep --no-index -l SECRET -- ~",
    // The same, other spellings.
    "git grep --no-index -l SECRET 'apps/*'",
    "git grep --no-index -l SECRET apps/*",
    "git grep --no-index -l SECRET -- '*'",
    "git grep --no-index -l SECRET -- 'a*'",
    "git grep --no-index -l SECRET -- ':(top)apps'",
    "git grep --no-index -l SECRET -- ':/'",
    "git grep --no-index -l SECRET -- ':!docs' ':/apps'",
    "git grep --no-index -l SECRET -- ../",
    "git grep --no-index -l SECRET -- ../repo",
    "git grep --no-index -l SECRET -- /",
    "git grep --untracked --no-exclude-standard -l SECRET -- 'apps/*'",
    "git grep --no-index -l SECRET -- 'apps/b*'",
    // `grep -r` and `rg -u` get the same operand reading: the shell expands a glob, `..` is above the root.
    "grep -r KEY apps/*",
    "grep -r KEY 'apps/*'",
    "grep -r KEY ..",
    "grep -r KEY ~",
    "grep -rn KEY /",
    "rg -u KEY 'apps/*'",
    "rg -u KEY ..",
    "rg --hidden KEY ~",
  ])("asks: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "git grep --no-index -l SECRET -- apps/web",
    "git grep --no-index -l SECRET -- 'scripts/*.ts'",
    "git grep --no-index -l SECRET -- 'src/**/*.ts'",
    "git grep --no-index -l SECRET -- 'docs/**'",
    "git grep --no-index -l SECRET -- '*.md'",
    "git grep --no-index -l SECRET -- '**/*.ts'",
    "git grep --no-index --exclude-standard -l SECRET -- 'apps/*'",
    "git grep -l SECRET -- 'apps/*'",
    "git grep -l SECRET -- ':(glob)apps/**'",
    "git grep -l SECRET :/apps",
    "git grep -l SECRET -- ..",
    "git grep --no-index -l SECRET -- /tmp/x",
    "git grep --no-index -l SECRET -- '/tmp/*'",
    "git grep --no-index -l SECRET -- ~/Downloads",
    "grep -r KEY 'scripts/*.ts'",
    "grep -r KEY scripts/*",
    "grep -r KEY docs",
    "grep -r --include='*.ts' KEY apps",
    "rg -u KEY 'scripts/*'",
    "rg KEY ..",
    "rg KEY 'apps/*'",
    "grep KEY apps/*",
  ])("allows: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("a directory above the repo asks, by name or by glob", () => {
    for (const cmd of [
      "git grep --no-index -l SECRET -- ~/Apps",
      "git grep --no-index -l SECRET -- '~/Apps/*'",
      "git grep --no-index -l SECRET -- ../repo",
      "git grep --no-index -l SECRET -- '../*'",
      "git grep --no-index -l SECRET -- /Users",
      "git grep --no-index -l SECRET -- '/Users/*'",
      "grep -r KEY ~/Apps",
      "grep -r KEY '/Users/dev/*'",
      "diff -r /tmp/x ~/Apps",
      "git diff --no-index /tmp/x '../*'",
    ]) {
      expect(d(cmd, underHome), cmd).toBe("ask");
    }
    for (const cmd of [
      "git grep --no-index -l SECRET -- ~/Downloads",
      "git grep --no-index -l SECRET -- '~/Downloads/*'",
      "git grep --no-index -l SECRET -- '/tmp/*'",
      "diff -r ~/Downloads/a ~/Downloads/b",
    ]) {
      expect(d(cmd, underHome), cmd).toBe("allow");
    }
  });

  it("a magic pathspec cannot be placed, so it asks even when it only names a harmless directory", () => {
    expect(d("git grep --no-index -l SECRET -- ':(glob)scripts/**/*.ts'")).toBe("ask");
  });

  it("a glob that expands onto a live env file by name is a deny, as before", () => {
    expect(d("git grep --no-index -l SECRET -- 'apps/*/.e*'")).toBe("deny");
    expect(d("git grep --no-index -l SECRET -- ':(glob)**/.env'")).toBe("deny");
  });

  it("a glob is placed by what it can match: with no live env file on disk it is everyday, magic and `..` are not", () => {
    expect(d("git grep --no-index -l SECRET -- 'apps/*'", noEnv)).toBe("allow");
    expect(d("git grep --no-index -l SECRET apps/*", noEnv)).toBe("allow");
    expect(d("grep -r KEY 'apps/*'", noEnv)).toBe("allow");
    expect(d("git grep --no-index -l SECRET :/apps", noEnv)).toBe("ask");
    expect(d("git grep --no-index -l SECRET -- ':!docs'", noEnv)).toBe("ask");
    expect(d("git grep --no-index -l SECRET -- ..", noEnv)).toBe("ask");
    expect(d("git grep --no-index -l SECRET -- ~", noEnv)).toBe("ask");
  });
});
