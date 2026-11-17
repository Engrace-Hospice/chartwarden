/**
 * The live suite files the checkout holds (wave 7, CR5-11; wave 8, CR6-6).
 * ------------------------------------------------------------------------------------------------
 * vitest filters test files by SUBSTRING of their path, so `bunx vitest run care-plan-conformance` runs
 * `apps/backend/__tests__/care-plan-conformance.live.test.ts`, which `DROP ROLE chartwarden_app` on the shared
 * cluster. A filter that is a substring of one of them is a live run (`live-suite.ts`). The list is read from the tree:
 * `*.live.test.ts` and `.tsx` under `apps`, `packages`, `services` and `scripts`, without `node_modules`, `dist`,
 * `build` and the like, bounded (a few thousand directories at most), and read on demand, once per command, only when a
 * runner is started with a filter. An untracked suite is listed too. The listing says whether it saw everything
 * (`complete`): a directory cap (a loop that creates 17,000 empty directories used to empty the list), a depth cap, a
 * directory it could not read, a symlink to a directory outside the walked roots and a symlink it cannot resolve make it
 * incomplete, and a filter then "may match" (ask). A symlink is decided by its target (wave 9, W9-0): a link to a file is
 * judged like a file (by its own name and by the name of what it points at), a dangling link holds nothing, and a link to a
 * directory inside the walked roots holds nothing new (a Linux virtualenv's `lib64 -> lib`) unless its target lies under a
 * skipped directory (wave 10, B11), which makes the listing incomplete. Not pure: it reads the file system.
 */
import { type Dirent, readdirSync, realpathSync } from "node:fs";
import type { Listing } from "./listing";
import { linkRealName, linkTarget } from "./symlink-target";

const ROOTS: readonly string[] = ["apps", "packages", "services", "scripts"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const LIVE_SUITE_FILE = /\.live\.test\.tsx?$/;
/** The real tree reaches depth 8; a suite deeper than this is a gap, not a non-suite. */
const MAX_DEPTH = 16;
const MAX_DIRECTORIES = 5000;

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** Repo-relative paths of the live suite files under `root`, and whether the walk saw everything. */
export function listLiveSuiteFiles(root: string): Listing {
  const base = root.replace(/\/+$/, "");
  let walkedRoots: readonly string[] | null = null;
  /**
   * A link to a directory that lies inside a walked root, by a path with no skipped directory in it, is a second name for
   * something walked on its own. One whose target lies under a skipped directory (`apps/web/src/viadist -> ../dist`) leads to
   * a place the walk never entered: a gap (wave 10, B11; round-7 R7-CR-11).
   */
  const insideWalkedRoots = (path: string): boolean => {
    walkedRoots ??= ROOTS.map((top) => realOrNull(`${base}/${top}`)).filter(
      (real): real is string => real !== null,
    );
    const real = realOrNull(path);
    if (real === null) return false;
    const top = walkedRoots.find((root) => real === root || real.startsWith(`${root}/`));
    if (top === undefined) return false;
    return !real
      .slice(top.length)
      .split("/")
      .some((segment) => SKIPPED_DIRECTORIES.has(segment));
  };
  const found: string[] = [];
  let directories = 0;
  let complete = true;
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || directories++ >= MAX_DIRECTORIES) {
      complete = false;
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(`${base}/${rel}`, { withFileTypes: true });
    } catch (error) {
      // A root the checkout lacks is normal; one that exists and cannot be read is a gap.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = `${rel}/${entry.name}`;
      const target = entry.isSymbolicLink() ? linkTarget(`${base}/${path}`) : null;
      if (target === "unreadable") complete = false;
      else if (target === "directory") complete &&= insideWalkedRoots(`${base}/${path}`);
      else if (target === "dangling") continue;
      else if (entry.isDirectory()) walk(path, depth + 1);
      // A link to a file is judged by its own name and by the name of the file it points at (`alias.test.ts -> real.live.test.ts`).
      else if (LIVE_SUITE_FILE.test(entry.name)) found.push(path);
      else if (target === "file" && LIVE_SUITE_FILE.test(linkRealName(`${base}/${path}`) ?? "")) {
        found.push(path);
      }
    }
  };
  for (const top of ROOTS) walk(top, 0);
  return { files: found, complete };
}
