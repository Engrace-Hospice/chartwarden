/**
 * The package scripts the command's package defines, for the runner reader (`runners.ts`, wave 8, T1).
 * ------------------------------------------------------------------------------------------------
 * `bun run X` runs the package script X, or, when there is none, the PATH program X (`bun run echo hello` runs `echo`).
 * Which one it is depends on the `scripts` of the nearest `package.json`, so the classifier is handed a reader (like
 * `liveEnvFiles`), asked at most once per command and only when a name needs it. Without a reader (a unit test that
 * injects nothing) the usual script names of this repo are the whole list. Not pure: `listPackageScripts` reads the file system.
 */
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

import type { ScriptLookup } from "./runners";

/** The scripts without a colon this repo defines: the fallback for a caller that cannot read `package.json`. */
const FALLBACK_SCRIPTS: ReadonlySet<string> = new Set([
  ..."prepare dev build typecheck clean lint test scaffold start t".split(" "),
]);

/** How far up from the working directory the nearest `package.json` is looked for. */
const MAX_LEVELS = 16;

const scriptKeys = (file: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
    return scripts !== null && typeof scripts === "object" ? Object.keys(scripts) : [];
  } catch {
    return [];
  }
};

/**
 * The script names of the nearest `package.json` at or above `cwd` (within `root`), and of the root's: a command run after
 * `cd apps/web` sees that package's scripts, and the root's are a fair second reading.
 */
export function listPackageScripts(root: string, cwd: string): ReadonlySet<string> {
  const names = new Set(scriptKeys(join(root, "package.json")));
  const inside = (dir: string): boolean => {
    const rel = relative(root, dir);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  };
  for (let dir = cwd, level = 0; inside(dir) && level < MAX_LEVELS; dir = dirname(dir), level++) {
    const own = scriptKeys(join(dir, "package.json"));
    if (own.length === 0) continue;
    for (const name of own) names.add(name);
    break;
  }
  return names;
}

let reader: (() => ReadonlySet<string>) | undefined;
let cached: ReadonlySet<string> | undefined;

/** Set (or clear) the reader for the command about to be classified; one-shot state, like the live env file list. */
export function setPackageScriptsReader(read: (() => ReadonlySet<string>) | undefined): void {
  reader = read;
  cached = undefined;
}

/** Is `name` a package script of the command's package? A name with a colon always is (`arch:fitness`). */
export const isPackageScript: ScriptLookup = (name) => {
  if (name.includes(":")) return true;
  if (reader === undefined) return FALLBACK_SCRIPTS.has(name);
  cached ??= reader();
  return cached.has(name);
};
