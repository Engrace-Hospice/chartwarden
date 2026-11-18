/**
 * Wave 6, CR-C3 (round-4 code review): the `find` name narrowing was judged against a hand-kept list that was 63 names
 * short, `hard-deadline.ts` among them. `find . -name 'hard-deadline.ts' -delete`, `-exec rm`, `-iname 'hard-dead*'` and
 * `-name 'guard-*'` all answered `allow`; deleting `hard-deadline.ts` makes the Claude guard exit 1, which Claude Code
 * reads as allow for every later call. The names are now listed from the tree by the same `isProtectedPath` that decides
 * what is protected (`protected-names.ts`). This test goes over EVERY tracked protected file, one by one, by its exact
 * name: there is no extension sample that could stand in for a missing name. The mutant that left the old list stale
 * (M19) survived because the old test accepted "or an extension it has a sample for".
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { protectedFindSamples } from "../harness/find-expr";
import { classifyBash } from "../harness/patterns";
import { protectedNameSamples, protectedTreeFiles } from "../harness/protected-names";
import { PROTECTED_LISTING_ROOTS, isProtectedPath } from "../harness/protected-paths";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;

const tracked = execFileSync("git", ["ls-files"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\n")
  .filter((f) => f !== "" && isProtectedPath(f));
const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);
/** A single-quoted shell word. */
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

describe("the protected files are listed from the tree", () => {
  it("finds the protected files the repository tracks (more than a hundred)", () => {
    expect(tracked.length).toBeGreaterThan(100);
  });
  it("lists every one of them: no listing root is missing", () => {
    const listed = new Set(protectedTreeFiles());
    expect(tracked.filter((f) => !listed.has(f))).toEqual([]);
  });
  it("lists only protected files, once each, in a bounded number", () => {
    const files = protectedTreeFiles();
    expect(new Set(files).size).toBe(files.length);
    expect(files.every((f) => isProtectedPath(f))).toBe(true);
    expect(files.length).toBeLessThan(5000);
  });
  it("includes the two modules whose removal makes the Claude guard exit 1", () => {
    const names = protectedTreeFiles();
    expect(names).toContain("scripts/harness/hard-deadline.ts");
    expect(names).toContain("scripts/harness/pre-tool-guard.ts");
  });
  it("the samples hold the tree's names, the named samples and no home-directory path", () => {
    const samples = protectedNameSamples();
    expect(samples).toContain("scripts/harness/hard-deadline.ts");
    expect(samples).toContain(".claude/settings.local.json");
    expect(samples.some((s) => s.startsWith("~/"))).toBe(false);
    expect(new Set(protectedFindSamples())).toContain("x.ts");
  });
  it("every listing root is a real directory name of the protected set (no stray entries)", () => {
    for (const { dir } of PROTECTED_LISTING_ROOTS) expect(dir).not.toMatch(/^\/|\/$/);
  });
});

describe("CR-C3: find cannot be narrowed away from a protected file the tree holds", () => {
  // The reviewer's repros: all `allow` at the base of this wave.
  it.each([
    "find . -name 'hard-deadline.ts' -delete",
    "find . -name hard-deadline.ts -exec rm {} +",
    "find . -iname 'hard-dead*' -delete",
    "find . -name 'guard-*' -delete",
    "find . -name 'guard-judge.ts' -delete",
    "find . -name 'work-budget.ts' -delete",
    "find . -name 'wrappers.ts' -exec rm -f {} \\;",
    "find . -name 'written-scripts.ts' -delete",
    "find . -path '*harness/hard-deadline.ts' -delete",
    "find . -path './scripts/harness/hard-*' -delete",
    "find scripts -name 'hard-deadline.ts' -delete",
  ])("asks: %s", (cmd) => {
    expect(d(cmd), cmd).not.toBe("allow");
  });

  // One row per tracked protected file, four spellings each.
  const FILE_COUNT = tracked.length;
  it(`goes over every one of the ${FILE_COUNT} tracked protected files by exact name`, () => {
    const escaped: string[] = [];
    for (const file of tracked) {
      const name = base(file);
      const spellings = [
        `find . -name ${q(name)} -delete`,
        `find . -iname ${q(name.toUpperCase())} -delete`,
        `find . -path ${q(`./${file}`)} -delete`,
        `find . -name ${q(name)} -exec rm {} +`,
      ];
      for (const cmd of spellings) if (d(cmd) === "allow") escaped.push(cmd);
    }
    expect(escaped).toEqual([]);
  });

  it("everyday finds that cannot touch a protected file still allow", () => {
    for (const cmd of [
      "find . -name '*.tmp' -delete",
      "find . -name '*.log' -delete",
      "find . -name '*.pyc' -delete",
      "find . -name '.DS_Store' -delete",
      "find . -name '*.orig' -delete",
      "find . -type d -name node_modules -prune -exec rm -rf {} +",
      "find . -name '*.ts' -print",
      "find . -name '*.ts'",
      "find src -name x.ts -delete",
      "find src -name '*.ts' -delete",
      "find /tmp/x -name '*.ts' -delete",
      "find apps/web -name '*.test.ts' -print",
      "find . -name 'hard-deadline.ts' -print",
      "find . -newer package.json -print",
    ]) {
      expect(d(cmd), cmd).toBe("allow");
    }
  });
});
