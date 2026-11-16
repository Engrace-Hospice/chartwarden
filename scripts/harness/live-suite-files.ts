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
 * symlinked directory and a directory it could not read make it incomplete, and a filter then "may match" (ask). Not pure:
 * it reads the file system.
 */
import { type Dirent, readdirSync } from "node:fs";
import type { Listing } from "./listing";

const ROOTS: readonly string[] = ["apps", "packages", "services", "scripts"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const LIVE_SUITE_FILE = /\.live\.test\.tsx?$/;
/** The real tree reaches depth 8; a suite deeper than this is a gap, not a non-suite. */
const MAX_DEPTH = 16;
const MAX_DIRECTORIES = 5000;

/** Repo-relative paths of the live suite files under `root`, and whether the walk saw everything. */
export function listLiveSuiteFiles(root: string): Listing {
  const base = root.replace(/\/+$/, "");
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
      if (entry.isSymbolicLink()) complete = false;
      else if (entry.isDirectory()) walk(`${rel}/${entry.name}`, depth + 1);
      else if (LIVE_SUITE_FILE.test(entry.name)) found.push(`${rel}/${entry.name}`);
    }
  };
  for (const top of ROOTS) walk(top, 0);
  return { files: found, complete };
}
