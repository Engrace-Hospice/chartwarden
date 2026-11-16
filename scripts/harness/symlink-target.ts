/**
 * What a symlink points at (wave 9, W9-0). `Dirent.isSymbolicLink()` says only that an entry is a link, never what it
 * links to: wave 8 treated every link as a gap in the live-suite and live-env listings, and a Python virtualenv's
 * `bin/python -> python3.12` (a link to a FILE) made every `bunx vitest run <filter>` ask on the real checkout. A link is
 * decided by its target. `statSync` follows it. Reads the file system.
 */
import { realpathSync, statSync } from "node:fs";
import { basename } from "node:path";

/**
 * - `file`: the link points at something that is not a directory; judge it by its name, like a file.
 * - `directory`: it points at a directory; whether that is a gap is the caller's decision.
 * - `dangling`: the target does not exist, so the link holds nothing.
 * - `unreadable`: the target cannot be resolved (a link that loops back on itself, a permission error): a gap.
 */
export type LinkTarget = "file" | "directory" | "dangling" | "unreadable";

export function linkTarget(path: string): LinkTarget {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "dangling" : "unreadable";
  }
}

/** The base name of what a link finally points at (`alias.test.ts -> real.live.test.ts` is `real.live.test.ts`), or null when it cannot be resolved. */
export function linkRealName(path: string): string | null {
  try {
    return basename(realpathSync(path));
  } catch {
    return null;
  }
}
