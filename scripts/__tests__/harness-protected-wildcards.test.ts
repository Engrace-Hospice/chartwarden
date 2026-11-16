/**
 * Wave 7, T5, CR5-4 and CR5-5 (round-5 code review).
 *
 * CR5-4 (CRITICAL, a regression from wave 3): a wildcard pathspec on a protected directory allowed. `git rm
 * 'scripts/harness/hard-dead*'` removes the guard's entry module, after which every Claude call fails; the test was
 * `hasWildcard(rel) ? wildcardReachesProtected(rel) : protectedTouch(rel, WHOLE_TREE)`, which dropped the literal
 * `scripts/harness/` prefix for any wildcard and tried the wildcard against one sample name. Now the prefix counts, and the
 * wildcard is tried against the names the tree holds.
 *
 * CR5-5 (HIGH): the names a wildcard is tried against were listed with ONE shared 5,000-entry budget, in an order that put
 * the guard last, and truncation or an unreadable directory failed open: 6,000 files in `.claude/.cache` made
 * `find . -name 'hard-deadline.ts' -delete` allow. Now each listing root has its own budget, the guard roots are listed
 * first, and an incomplete listing makes every name test and every pathspec wildcard "may match" (fail closed).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { listProtectedFrom } from "../harness/protected-names";
import { bashPayload, guardCopy, removeCopies, runClaude } from "./_guard-copy";

afterAll(removeCopies);

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const RM = ["git", "rm"].join(" ");

describe("CR5-4: a wildcard pathspec on a protected directory asks", () => {
  it.each([
    `${RM} 'scripts/harness/hard-dead*'`,
    `${RM} -f 'scripts/harness/hard-dead*'`,
    `${RM} 'scripts/harness/pre-tool*'`,
    `${RM} 'scripts/harness/guard-w*'`,
    `${RM} -r 'scripts/harness/*'`,
    `${RM} --cached 'scripts/harness/*.ts'`,
    `git mv 'scripts/harness/hard-dead*' /tmp/x`,
    `git restore -s HEAD~5 'scripts/harness/hard-dead*'`,
    `git restore --source=HEAD~5 'scripts/harness/*.ts'`,
    `git checkout HEAD~5 -- 'scripts/harness/hard-dead*'`,
    `git checkout -- 'scripts/harness/p*'`,
    `${RM} '.claude/sett*'`,
    `${RM} '.claude/rules/*'`,
    `${RM} 'compliance/contr*'`,
    `${RM} 'compliance/*.yaml'`,
    `${RM} 'deploy/production/comp*'`,
    `${RM} 'deploy/production/*'`,
    `${RM} '.githooks/pre-*'`,
    `${RM} '.github/workflows/*.yml'`,
    `git mv 'compliance/*' /tmp/x`,
    `git checkout HEAD~1 -- 'scripts/harness/zzz-not-yet-*'`,
    `${RM} 'compliance/zzz-not-yet-*'`,
    `git restore -s HEAD~1 '.claude/rules/zzz-not-yet-*'`,
    `git checkout HEAD~1 -- 'scripts/h*/hard-deadline.ts'`,
    `cd scripts/harness && ${RM} 'hard-dead*'`,
    `cd scripts && ${RM} 'harness/hard-dead*'`,
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("the literal control still asks", () => {
    expect(d(`${RM} -f scripts/harness/hard-deadline.ts`)).toBe("ask");
  });

  it.each([
    `${RM} 'apps/web/src/*.orig'`,
    `${RM} --cached 'docs/*.bak'`,
    `git mv 'docs/a*.md' docs/old/`,
    `git checkout -- 'apps/*/src/x.ts'`,
    `git restore 'apps/web/src/*.tsx'`,
    `git restore --staged 'packages/*/index.ts'`,
    `git add 'scripts/harness/*.ts'`,
    `git diff -- 'scripts/harness/*.ts'`,
    `git log -- 'scripts/harness/*.ts'`,
  ])("everyday neighbour stays allowed: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

/** A throwaway tree shaped like the repo, removed by the test run. */
const scratch: string[] = [];
function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-names-"));
  scratch.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const touch = (root: string, rel: string): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), "");
};
const many = (root: string, dir: string, count: number): void => {
  mkdirSync(join(root, dir), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(root, dir, `f${i}.json`), "");
};

describe("CR5-5: the protected names are listed per root, guard first, and an incomplete listing says so", () => {
  it("a tree that holds only some roots is complete", () => {
    const root = tree();
    touch(root, "scripts/harness/hard-deadline.ts");
    const r = listProtectedFrom(root);
    expect(r.files).toContain("scripts/harness/hard-deadline.ts");
    expect(r.complete).toBe(true);
  });

  it("6,000 files in an early root no longer starve the guard roots, and the listing says it is incomplete", () => {
    const root = tree();
    touch(root, "scripts/harness/hard-deadline.ts");
    touch(root, "compliance/controls.yaml");
    touch(root, "deploy/production/compose.yml");
    many(root, ".claude/.cache", 6000);
    const r = listProtectedFrom(root);
    expect(r.files).toContain("scripts/harness/hard-deadline.ts");
    expect(r.files).toContain("compliance/controls.yaml");
    expect(r.files).toContain("deploy/production/compose.yml");
    expect(r.complete).toBe(false);
  });

  it("a root over its own budget is incomplete, and the other roots still count", () => {
    const root = tree();
    many(root, "scripts/harness", 12);
    touch(root, "compliance/controls.yaml");
    const r = listProtectedFrom(root, 5);
    expect(r.complete).toBe(false);
    expect(r.files).toContain("compliance/controls.yaml");
  });

  it("a file deeper than the walk goes makes the listing incomplete", () => {
    const root = tree();
    touch(root, "scripts/harness/a/b/c/d/e/f/g.ts");
    expect(listProtectedFrom(root).complete).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "a directory that exists and cannot be read makes it incomplete",
    () => {
      const root = tree();
      touch(root, ".githooks/pre-commit");
      chmodSync(join(root, ".githooks"), 0o000);
      try {
        expect(listProtectedFrom(root).complete).toBe(false);
      } finally {
        chmodSync(join(root, ".githooks"), 0o755);
      }
    },
  );

  it("a root the checkout lacks is not a gap", () => {
    expect(listProtectedFrom(tree()).complete).toBe(true);
  });
});

describe("CR5-5: the real hooks, on a copy of the guard tree with a big cache directory", () => {
  const BLOAT = 6000;
  const bloated = (dir: string, under: string): string => {
    many(dir, under, BLOAT);
    return dir;
  };

  it.each([
    "find . -name 'hard-deadline.ts' -delete",
    "find . -name 'guard-worker.ts' -delete",
    "find . -name 'hard-dead*' -delete",
  ])("a big .claude/.cache no longer lets `%s` through", (cmd) => {
    const dir = bloated(guardCopy(), ".claude/.cache");
    expect(runClaude(dir, bashPayload(cmd)).decision, cmd).toBe("ask");
  });

  it("when a guard root itself is too big to list, every name test is broad (fail closed)", () => {
    const intact = guardCopy();
    expect(runClaude(intact, bashPayload("find . -name '*.tmp' -delete")).decision).toBe("allow");
    const dir = bloated(guardCopy(), "scripts/harness/spill");
    expect(runClaude(dir, bashPayload("find . -name '*.tmp' -delete")).decision).toBe("ask");
    expect(runClaude(dir, bashPayload(`${RM} 'apps/*/x.tmp'`)).decision).toBe("ask");
  });

  it("control: on the intact copy the same commands ask only for the protected names", () => {
    const dir = guardCopy();
    expect(runClaude(dir, bashPayload("find . -name 'hard-deadline.ts' -delete")).decision).toBe(
      "ask",
    );
    expect(runClaude(dir, bashPayload(`${RM} 'apps/*/x.tmp'`)).decision).toBe("allow");
  });
});
