/**
 * The live suite files the checkout holds (wave 7, CR5-11).
 * ------------------------------------------------------------------------------------------------
 * vitest filters test files by SUBSTRING of their path, so `bunx vitest run care-plan-conformance` runs
 * `apps/backend/__tests__/care-plan-conformance.live.test.ts`, which `DROP ROLE chartwarden_app` on the shared
 * cluster. A filter that is a substring of one of them is a live run (`live-suite.ts`). The list is read from the tree:
 * `*.live.test.ts` and `.tsx` under `apps`, `packages`, `services` and `scripts`, without `node_modules`, `dist`,
 * `build` and the like, bounded (a few thousand directories at most), and read on demand, once per command, only when a
 * runner is started with a filter. An untracked suite is listed too; one deeper than the walk goes is not. Not pure: it
 * reads the file system.
 */
import { type Dirent, readdirSync } from "node:fs";

const ROOTS: readonly string[] = ["apps", "packages", "services", "scripts"];
const SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);
const LIVE_SUITE_FILE = /\.live\.test\.tsx?$/;
const MAX_DEPTH = 8;
const MAX_DIRECTORIES = 5000;

/** Repo-relative paths of the live suite files under `root`. */
export function listLiveSuiteFiles(root: string): string[] {
  const base = root.replace(/\/+$/, "");
  const found: string[] = [];
  let directories = 0;
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_DEPTH || directories++ >= MAX_DIRECTORIES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(`${base}/${rel}`, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(`${rel}/${entry.name}`, depth + 1);
      } else if (LIVE_SUITE_FILE.test(entry.name)) found.push(`${rel}/${entry.name}`);
    }
  };
  for (const top of ROOTS) walk(top, 0);
  return found;
}
