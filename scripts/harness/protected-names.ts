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
/** What ONE listing root may spend: a shared budget let a big cache directory starve the roots listed after it. */
export const MAX_ENTRIES_PER_ROOT = 5000;
/** The protected names a tree holds, and whether the listing saw all of them. */
export interface ProtectedListing {
  readonly files: readonly string[];
  /** False when a root ran out of budget, a directory could not be read, or a file lay deeper than the walk goes. */
  readonly complete: boolean;
}

interface Walk {
  left: number;
  complete: boolean;
}

/** Every protected file under `dir` (repo-relative), recursively when asked; a directory that is not there is no finding. */
function walk(root: string, dir: string, recursive: boolean, state: Walk): string[] {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(`${root}${dir}`, { withFileTypes: true });
  } catch (error) {
    // A root the checkout lacks is normal; one that exists and cannot be read is a gap the callers must not trust.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") state.complete = false;
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (state.left-- <= 0) {
      state.complete = false;
      break;
    }
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isFile() && isProtectedPath(rel)) out.push(rel);
    else if (entry.isDirectory() && recursive) {
      if (rel.split("/").length <= MAX_DEPTH) out.push(...walk(root, rel, true, state));
      else state.complete = false;
    }
  }
  return out;
}

/** The protected files below `root`, each listing root with a budget of its own (order cannot starve one). */
export function listProtectedFrom(
  root: string,
  perRoot: number = MAX_ENTRIES_PER_ROOT,
): ProtectedListing {
  const base = root.endsWith("/") ? root : `${root}/`;
  const found: string[] = [];
  let complete = true;
  for (const { dir, recursive } of PROTECTED_LISTING_ROOTS) {
    const state: Walk = { left: perRoot, complete: true };
    found.push(...walk(base, dir, recursive, state));
    complete &&= state.complete;
  }
  return { files: [...new Set(found)], complete };
}

let cached: ProtectedListing | null = null;

function listing(): ProtectedListing {
  cached ??= listProtectedFrom(REPO_ROOT);
  return cached;
}

/** The protected files in the tree, as repo-relative paths. */
export function protectedTreeFiles(): readonly string[] {
  return listing().files;
}

/**
 * Did the listing see every protected file? When it did not (a root over its budget, an unreadable directory, a file
 * too deep), a rule that asks "could this wildcard match a protected file?" must say yes: the names it would try the
 * wildcard against are incomplete, and a guard that fails open on a big directory is not one.
 */
export const protectedNamesComplete = (): boolean => listing().complete;

/**
 * The protected names a wildcard must be tried against: the named samples (lower case, with the `x` placeholder
 * entries for a directory that may gain a file) and every protected file the tree holds. `~/…` samples are left out:
 * a wildcard over the repo is not one over the home directory.
 */
export function protectedNameSamples(): readonly string[] {
  const named = PROTECTED_SAMPLES.filter((s) => !s.startsWith("~/"));
  return [...new Set([...named, ...protectedTreeFiles()])];
}
