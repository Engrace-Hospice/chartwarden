#!/usr/bin/env bun
/**
 * ChartWarden — are the repo's git hooks installed in THIS clone? (`arch:hooks-installed`, CW-SEC-01)
 * ------------------------------------------------------------------------------------------------
 * `.githooks/pre-commit` is where a staged secret or PHI-shaped identifier is stopped before it is a commit.
 * Git runs it only when `core.hooksPath` points at `.githooks`, and that is per clone: a fresh clone that
 * skipped `bun install` (or ran `bun install --ignore-scripts`), or whose `prepare` step failed quietly
 * (it used to end in `|| true`), simply had no scan, and nothing said so.
 *
 *   bun run arch:hooks-installed                      check: fails when the hooks are not active here
 *   bun run scripts/check-hooks-installed.ts --install  what `prepare` runs: set core.hooksPath, fail loudly
 *
 * CHECK MODE is skipped under CI (the `CI` variable GitHub Actions sets), where the server-side `Secret and
 * PHI scan` job in pr-gate.yml is the control, and where there is no commit to protect. It is also skipped
 * when this is not a git work tree (a Docker build context, a source tarball): there is nothing to scan.
 * Anyone can still `git commit --no-verify` or set CI=1: this closes the SILENT gap, not a deliberate one
 * (the register row says so; only the required PR check, once applied, stops that).
 *
 * INSTALL MODE fails only when git is there and `git config` fails; with no git it skips quietly, so an
 * image build that runs `bun install` keeps working.
 */
import { spawnSync } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const HOOKS_DIR = ".githooks";
export const REQUIRED_HOOKS = ["pre-commit", "pre-push"] as const;
const REMEDY = "run `bun run setup:hooks` once in this clone";

export interface HookFile {
  readonly name: string;
  readonly exists: boolean;
  readonly executable: boolean;
}
export interface HooksState {
  /** `git config --get core.hooksPath` as git reports it, `undefined` when unset. */
  readonly hooksPath: string | undefined;
  readonly root: string;
  readonly hookFiles: readonly HookFile[];
}

/** PURE — what is wrong with the hook install, empty when the scan will run on `git commit`. */
export function hooksProblems(state: HooksState): string[] {
  const problems: string[] = [];
  const wanted = resolve(state.root, HOOKS_DIR);
  if (state.hooksPath === undefined || state.hooksPath.trim() === "")
    problems.push(`core.hooksPath is not set, so no git hook runs (${REMEDY})`);
  else if (resolve(state.root, state.hooksPath) !== wanted)
    problems.push(
      `core.hooksPath is \`${state.hooksPath}\`, not \`${HOOKS_DIR}\`: the secret scan will not run on commit (${REMEDY})`,
    );
  for (const h of state.hookFiles) {
    if (!h.exists) problems.push(`${HOOKS_DIR}/${h.name} is missing`);
    else if (!h.executable)
      problems.push(`${HOOKS_DIR}/${h.name} is not executable (git skips it): chmod +x it`);
  }
  return problems;
}

interface GitResult {
  readonly status: number | null;
  readonly out: string;
  readonly failedToRun: boolean;
}

function git(root: string, args: readonly string[]): GitResult {
  const r = spawnSync("git", [...args], { cwd: root, encoding: "utf8" });
  return { status: r.status, out: (r.stdout ?? "").trim(), failedToRun: r.error !== undefined };
}

function insideWorkTree(root: string): boolean {
  const r = git(root, ["rev-parse", "--is-inside-work-tree"]);
  return !r.failedToRun && r.status === 0 && r.out === "true";
}

function readHookFile(root: string, name: string): HookFile {
  const path = join(root, HOOKS_DIR, name);
  try {
    statSync(path);
  } catch {
    return { name, exists: false, executable: false };
  }
  try {
    // Windows has no execute bit; git there runs the hook through its own shell regardless.
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return { name, exists: true, executable: true };
  } catch {
    return { name, exists: true, executable: false };
  }
}

function install(root: string): number {
  if (!insideWorkTree(root)) {
    console.log("hooks: not a git work tree (or no git): nothing to install");
    return 0;
  }
  const set = git(root, ["config", "core.hooksPath", HOOKS_DIR]);
  if (set.status !== 0) {
    console.error(
      `hooks: could not set core.hooksPath to ${HOOKS_DIR}: the secret scan would not run on commit. Fix the git config error, then ${REMEDY}.`,
    );
    return 1;
  }
  console.log(`hooks: core.hooksPath -> ${HOOKS_DIR}`);
  return 0;
}

function check(root: string): number {
  if (process.env.CI) {
    console.log(
      "SKIP check-hooks-installed: CI (the pr-gate `Secret and PHI scan` job is the control)",
    );
    return 0;
  }
  if (!insideWorkTree(root)) {
    console.log("SKIP check-hooks-installed: not a git work tree");
    return 0;
  }
  const configured = git(root, ["config", "--get", "core.hooksPath"]);
  const problems = hooksProblems({
    hooksPath: configured.status === 0 ? configured.out : undefined,
    root,
    hookFiles: REQUIRED_HOOKS.map((name) => readHookFile(root, name)),
  });
  if (problems.length === 0) {
    console.log(
      "OK check-hooks-installed: core.hooksPath -> .githooks and the hooks are executable",
    );
    return 0;
  }
  console.error(`FAIL check-hooks-installed: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

if (import.meta.main) {
  const root = process.cwd();
  process.exit(process.argv.includes("--install") ? install(root) : check(root));
}
