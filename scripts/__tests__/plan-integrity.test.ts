// check-plan-integrity must diff against origin/main, not a stale local main (worktree false-fail),
// while a branch that really edits docs/plans must still fail.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "../check-plan-integrity.ts");
let root: string;
let work: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
  });
const commit = (cwd: string, rel: string, body: string) => {
  mkdirSync(dirname(join(cwd, rel)), { recursive: true });
  writeFileSync(join(cwd, rel), body);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-qm", `edit ${rel}`);
};
const runGate = () =>
  spawnSync("bun", [SCRIPT], {
    cwd: work,
    encoding: "utf8",
    env: { ...process.env, ALLOW_PLAN_EDITS: "" },
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plan-integrity-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, seed);
  git(seed, "checkout", "-q", "-b", "main");
  commit(seed, "docs/plans/p.md", "v1");
  git(seed, "push", "-q", "origin", "main");
  work = join(root, "work");
  git(root, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "feature");
  // origin/main moves ahead (a plan changes upstream) while local `main` stays stale.
  commit(seed, "docs/plans/p.md", "v2 upstream");
  git(seed, "push", "-q", "origin", "main");
  git(work, "fetch", "-q", "origin");
  git(work, "merge", "-q", "--no-edit", "origin/main");
  commit(work, "src/a.ts", "x");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("check-plan-integrity base ref", () => {
  it("does not false-fail when local main lags origin/main", () => {
    const r = runGate();
    expect(r.status, r.stderr).toBe(0);
  });

  it("still fails when the branch edits docs/plans", () => {
    commit(work, "docs/plans/p.md", "v3 local edit");
    const r = runGate();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docs/plans/p.md");
  });
});
