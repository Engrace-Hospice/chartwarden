/**
 * ADV-M6 (2026-11-10 adversarial review): whole-tree git writers (`reset --hard <old>`, `checkout -f`,
 * `switch --detach`, `stash pop`, `read-tree -u`, `checkout-index -a -f`, `cherry-pick`, `revert`, magic or
 * wildcard pathspecs) can silently put back an older, weaker guard, and `cd scripts/harness && git checkout
 * pre-tool-guard.ts` slipped because the word was looked up in the directory the shell STARTED in. They ask when
 * any directory the command may run in holds the repo; the everyday branch work next to them stays allowed.
 */
import { describe, expect, it } from "vitest";
import { hasWildcard, isMagicPathspec, wholeTreeWriterReason } from "../harness/git-tree-rules";
import { classifyBash } from "../harness/patterns";

const ROOT = "/repo";
const base = { root: ROOT, home: "/Users/dev", cwd: ROOT };
const v = (cmd: string, c: object = { ...base, exists: () => true }) => classifyBash(cmd, c);
const d = (cmd: string, c?: object) => v(cmd, c).decision;

describe("wholeTreeWriterReason", () => {
  it.each([
    ["reset", ["--hard"]],
    ["reset", ["--hard", "HEAD~5"]],
    ["reset", ["--har", "abc1234"]],
    ["reset", ["--merge"]],
    ["reset", ["--keep", "v1"]],
    ["checkout", ["-f", "main"]],
    ["checkout", ["--force", "main"]],
    ["checkout", ["-fb", "x"]],
    ["checkout", ["--detach", "main"]],
    ["checkout", ["abc1234"]],
    ["checkout", ["HEAD~3"]],
    ["checkout", ["main^"]],
    ["checkout", ["-b", "x", "HEAD~3"]],
    ["switch", ["-f", "main"]],
    ["switch", ["--discard-changes", "main"]],
    ["switch", ["--detach", "main"]],
    ["switch", ["-d", "main"]],
    ["switch", ["abc1234"]],
    ["stash", ["pop", "stash@{2}"]],
    ["stash", ["apply", "stash@{1}"]],
    ["stash", ["branch", "x", "stash@{3}"]],
    ["read-tree", ["-u", "HEAD~3"]],
    ["read-tree", ["--reset", "-u", "abc"]],
    ["checkout-index", ["-a", "-f"]],
    ["checkout-index", ["--all"]],
    ["cherry-pick", ["abc1234"]],
    ["revert", ["HEAD"]],
    ["merge", ["-X", "theirs", "other"]],
    ["merge", ["-Xours", "other"]],
    ["merge", ["-s", "ours", "other"]],
    ["pull", ["-X", "theirs"]],
  ])("rewrites the tree: git %s %j", (sub, rest) => {
    expect(wholeTreeWriterReason(sub, rest), `${sub} ${rest.join(" ")}`).toEqual(
      expect.stringContaining("git"),
    );
  });

  it.each([
    ["reset", []],
    ["reset", ["--soft", "HEAD~1"]],
    ["reset", ["HEAD", "file.ts"]],
    ["reset", ["--mixed"]],
    ["checkout", ["main"]],
    ["checkout", ["-b", "feature/x"]],
    ["checkout", ["-b", "x", "origin/main"]],
    ["checkout", ["HEAD", "--", "file.ts"]],
    ["checkout", ["HEAD~1", "file.ts"]],
    ["checkout", ["--", "file.ts"]],
    ["switch", ["main"]],
    ["switch", ["-c", "x"]],
    ["stash", []],
    ["stash", ["pop"]],
    ["stash", ["apply"]],
    ["stash", ["pop", "stash@{0}"]],
    ["rebase", ["--onto", "origin/main", "abc1234"]],
    ["stash", ["push", "-m", "x"]],
    ["stash", ["list"]],
    ["stash", ["drop"]],
    ["stash", ["show", "-p"]],
    ["read-tree", ["HEAD"]],
    ["checkout-index", ["file.ts"]],
    ["cherry-pick", ["--abort"]],
    ["cherry-pick", ["--continue"]],
    ["merge", ["main"]],
    ["merge", ["--no-ff", "feature"]],
    ["merge", ["--abort"]],
    ["rebase", ["main"]],
    ["rebase", ["--continue"]],
    ["pull", ["--ff-only"]],
    ["pull", ["origin", "main"]],
    ["status", []],
    ["log", ["--oneline"]],
  ])("is quiet about git %s %j", (sub, rest) => {
    expect(wholeTreeWriterReason(sub, rest), `${sub} ${rest.join(" ")}`).toBeNull();
  });
});

describe("pathspec helpers", () => {
  it.each([":/", ":/scripts", ":(top)scripts", ":(glob)**/x", ":^scripts"])(
    "%s is a magic pathspec",
    (p) => expect(isMagicPathspec(p)).toBe(true),
  );
  it.each(["scripts", "a:b", "./x"])("%s is not", (p) => expect(isMagicPathspec(p)).toBe(false));
  it.each(["*", "scripts/h*", "apps/*/src", "a?", "[ab]x", ".*"])("%s has a wildcard", (spec) =>
    expect(hasWildcard(spec)).toBe(true),
  );
  it.each(["scripts", "a/b.ts", "."])("%s has none", (spec) =>
    expect(hasWildcard(spec)).toBe(false),
  );
});

describe("the whole-tree writers ask, from every directory the command may run in", () => {
  it.each([
    "git reset --hard",
    "git reset --hard HEAD~5",
    "git reset --hard abc1234",
    "git checkout -f main",
    "git checkout --force",
    "git switch --discard-changes main",
    "git switch --detach abc1234",
    "git checkout abc1234",
    "git checkout HEAD~3",
    "git stash pop stash@{2}",
    "git stash apply stash@{1}",
    "git read-tree -u HEAD~3",
    "git checkout-index -f -a",
    "git cherry-pick abc1234",
    "git revert HEAD",
    "git merge -X theirs other",
    "git -C apps reset --hard",
    "cd apps/backend && git reset --hard",
    "git --work-tree=. reset --hard",
  ])("asks before %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, cmd).toBe("ask");
    expect(verdict.reason).toMatch(/guard|compliance|rewrites|applies|decides/);
  });

  it("judges every candidate directory: the second one is the other repo, the first holds ours", () => {
    expect(d("git -C /tmp/other reset --hard")).toBe("allow");
    expect(d("cd /tmp/other; git reset --hard")).toBe("ask"); // `;`: the cd may not have applied, so also here
    expect(d("cd /tmp/other && git reset --hard")).toBe("allow");
    expect(d("cd /tmp/other && git -C /repo reset --hard")).toBe("ask");
  });

  it("asks when the directory is one the guard cannot resolve", () => {
    expect(d('cd "$X" && git reset --hard')).toBe("ask");
  });

  it("an unknown cwd (no root) asks too", () => {
    expect(d("git reset --hard", { cwd: "/anywhere" })).toBe("ask");
  });
});

describe("everyday branch work stays allowed", () => {
  it.each([
    "git checkout main",
    "git checkout -b feature/x",
    "git checkout -b fix/y origin/main",
    "git switch main",
    "git switch -c feature/z",
    "git checkout -- apps/web/src/App.tsx",
    "git checkout HEAD -- apps/web/src/App.tsx",
    "git restore apps/web/src/App.tsx",
    "git reset",
    "git reset HEAD apps/web/src/App.tsx",
    "git reset --soft HEAD~1",
    "git stash",
    "git stash pop",
    "git stash apply",
    "git rebase --onto origin/main abc1234",
    "git stash push -m wip",
    "git stash list",
    "git merge main",
    "git merge --no-ff feature/x",
    "git rebase main",
    "git pull --ff-only",
    "git pull origin main",
    "git cherry-pick --abort",
    "git log --oneline -5",
    "git status --short",
  ])("allows %s", (cmd) => {
    const verdict = v(cmd);
    expect(verdict.decision, `${cmd}: ${verdict.reason}`).toBe("allow");
  });
});

describe("magic and wildcard pathspecs", () => {
  it.each([
    "git restore --source=HEAD~5 :/",
    "git restore --source=HEAD~5 ':/scripts'",
    "git checkout HEAD~5 -- ':(top)scripts'",
    "git checkout -- ':(glob)**/*.ts'",
    "git checkout -- *",
    "git restore *",
    "git checkout HEAD~5 -- scripts/h*",
    "git rm -- *",
    "git checkout -- .*",
  ])("asks before %s", (cmd) => expect(d(cmd), cmd).toBe("ask"));

  it.each([
    "git checkout -- apps/*",
    "git restore apps/web/src/*.tsx",
    "git restore docs/*.md",
    "git checkout -- packages/ui/src/a?.ts",
  ])("allows the wildcard that stays outside the harness: %s", (cmd) =>
    expect(d(cmd), cmd).toBe("allow"),
  );
});

describe("a lone word is a path where the command RUNS, not where the shell started", () => {
  /** Only `pre-tool-guard.ts` exists, and only in scripts/harness. */
  const exists = (p: string) => p === `${ROOT}/scripts/harness/pre-tool-guard.ts`;
  const c = { ...base, exists };

  it("asks about `cd scripts/harness && git checkout pre-tool-guard.ts`", () => {
    expect(d("cd scripts/harness && git checkout pre-tool-guard.ts", c)).toBe("ask");
    expect(d("cd scripts/harness && git checkout -- pre-tool-guard.ts", c)).toBe("ask");
  });
  it("asks when the file is named from the root", () => {
    expect(d("git checkout scripts/harness/pre-tool-guard.ts", c)).toBe("ask");
  });
  it("allows a branch of the same name where no such file exists", () => {
    expect(d("cd scripts/harness && git checkout some-branch", c)).toBe("allow");
    expect(d("git checkout pre-tool-guard.ts", c)).toBe("allow");
  });
});

describe("N18: git writes are judged from EVERY candidate directory, not only the first", () => {
  it("asks when only the second candidate directory reaches a protected path", () => {
    // `cd scripts/harness; ...` leaves two possible directories: the root, then scripts/harness.
    expect(d("cd scripts/harness; git checkout -- pre-tool-guard.ts")).toBe("ask");
    expect(d("cd scripts; git restore harness/pre-tool-guard.ts")).toBe("ask");
    expect(d("cd .claude; git rm settings.json")).toBe("ask");
  });
  it("asks when only the FIRST candidate directory reaches one (the cd moves away from it)", () => {
    expect(d("git checkout -- scripts/harness/pre-tool-guard.ts; cd /tmp; true")).toBe("ask");
    expect(d("cd /tmp; git checkout -- scripts/harness/pre-tool-guard.ts")).toBe("ask");
  });
  it("allows the same words where every candidate directory is ordinary", () => {
    expect(d("cd apps/web; git checkout -- src/App.tsx")).toBe("allow");
  });
});
