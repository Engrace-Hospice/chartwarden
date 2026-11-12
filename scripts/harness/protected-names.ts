/**
 * The protected files that exist, read from the tree (wave 6, CR-C3, CR-M5).
 * ------------------------------------------------------------------------------------------------
 * `protected-paths.ts` says what is protected as patterns: every file under `scripts/harness/`, `compliance/`,
 * `.githooks/`, `deploy/production/` …, and a few named files. A rule that has to ask "could this wildcard match a
 * protected file?" (`find . -name 'hard-dead*' -delete`, `git checkout -- 'scripts/harness/p*'`) needs the NAMES. They
 * used to be a hand-kept list that fell 63 names behind (`hard-deadline.ts` was not on it, and deleting that file makes
 * the Claude guard exit 1, which Claude Code reads as allow). They are now listed from the tree the guard runs in, by the
 * same {@link isProtectedPath} that decides what is protected, and joined with the named samples of
 * {@link PROTECTED_SAMPLES} (files an agent may create that no checkout holds: `settings.local.json`, the ledger).
 * Read once per process, on first use: about 3 ms. A directory that is not there is skipped. Not pure: it reads the
 * file system, so only a rule that needs the names calls it.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROTECTED_LISTING_ROOTS, PROTECTED_SAMPLES, isProtectedPath } from "./protected-paths";

/** The repo the guard script lives in (`scripts/harness/..` twice). */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MAX_DEPTH = 6;
const MAX_ENTRIES = 5000;

/** Every protected file under `dir` (repo-relative), recursively when asked; a bounded walk that ignores what it cannot read. */
function listProtected(dir: string, recursive: boolean, budget: { left: number }): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(`${REPO_ROOT}${dir}`, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (budget.left-- <= 0) break;
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isFile() && isProtectedPath(rel)) out.push(rel);
    else if (entry.isDirectory() && recursive && rel.split("/").length <= MAX_DEPTH) {
      out.push(...listProtected(rel, true, budget));
    }
  }
  return out;
}

let cached: readonly string[] | null = null;

/** The protected files in the tree, as repo-relative paths. */
export function protectedTreeFiles(): readonly string[] {
  if (cached !== null) return cached;
  const budget = { left: MAX_ENTRIES };
  const found = PROTECTED_LISTING_ROOTS.flatMap(({ dir, recursive }) =>
    listProtected(dir, recursive, budget),
  );
  cached = [...new Set(found)];
  return cached;
}

/**
 * The protected names a wildcard must be tried against: the named samples (lower case, with the `x` placeholder
 * entries for a directory that may gain a file) and every protected file the tree holds. `~/…` samples are left out:
 * a wildcard over the repo is not one over the home directory.
 */
export function protectedNameSamples(): readonly string[] {
  const named = PROTECTED_SAMPLES.filter((s) => !s.startsWith("~/"));
  return [...new Set([...named, ...protectedTreeFiles()])];
}
