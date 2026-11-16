/**
 * The live environment files that exist in the checkout, read from the file system (wave 7, CR5-7; wave 8, CR6-6).
 * ------------------------------------------------------------------------------------------------
 * A recursive read of a directory (`grep -r`, `cp -r`, `tar c`, `find -exec cat`, `diff -r`) is a secret read when
 * something under it is a live environment file. That used to be a hand-kept list of seven paths, which missed
 * `apps/portal/.env`, `services/<name>/.env`, `apps/web/.env.local` and a root `.env.local`. The question is now asked
 * of the tree: every `.env` or `.env.<suffix>` or `<name>.env` or `.envrc` that is not a tracked template (`.example`,
 * `.sample`, `.template`, `.dist`) in the repo root, `deploy/production`, and the direct children of `apps`, `services`,
 * `packages` and `deploy`. Bounded (a few hundred directory reads at most) and read on demand, once per classified
 * command. A file deeper than that is not listed; the fallback list in `secret-reads.ts` and the secret-path rules
 * still name the usual ones. The listing says whether it saw everything (`complete`): a directory over the cap, one it
 * could not read and a symlink under a parent (a directory behind it is not walked) make it incomplete, and the rules then
 * answer "may match" (ask), as the protected-names listing does (wave 8, CR6-6). A symlink is decided by its target (wave 9,
 * W9-0): a link to a file is a file (judged by its own name and by the name of what it points at, wave 10, B11), a dangling link holds nothing, and only a link to a directory is a gap. Not pure: it reads the file system (a test
 * passes its own reader).
 */
import { readdirSync } from "node:fs";
import type { Listing } from "./listing";
import { linkRealName, linkTarget } from "./symlink-target";

/** Directories whose direct children are listed as locations of env files. */
const PARENT_DIRECTORIES: readonly string[] = ["apps", "services", "packages", "deploy"];
/** Directories that are themselves a location. */
const DIRECT_DIRECTORIES: readonly string[] = ["", "deploy/production"];
/** At most this many directories are read in one listing. */
const MAX_DIRECTORIES = 400;

/** `.env`, `.env.local`, `.env.production`, `backend.env`, `.deploy-alert.env`, `.envrc`: a live env file by name. */
const ENV_FILE_NAME = /^\.env(?:\.[\w.-]+)?$|^[\w.-]+\.env$|^\.envrc$/;
/** The tracked templates that sit beside the live files. */
const TEMPLATE_NAME = /\.(?:example|sample|template|dist)$/i;

/** The entries of a directory (repo-relative; `""` is the root). It throws when the directory cannot be read. */
export type DirectoryReader = (dir: string) => readonly {
  readonly name: string;
  readonly isDirectory: boolean;
  /** A symlink to a directory (or one that cannot be resolved): a directory behind one is not walked, so the listing is not complete. */
  readonly isSymbolicLink?: boolean;
  /** The name of the file a link to a file points at: a link is judged by its own name and by this one. */
  readonly targetName?: string;
}[];

/** A symlink is decided by its target (wave 9, W9-0): a link to a file is a file, a dangling link is gone, the rest is a gap. */
const readFromDisk =
  (root: string): DirectoryReader =>
  (dir) => {
    const path = `${root}${dir === "" ? "" : `/${dir}`}`;
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const target = entry.isSymbolicLink() ? linkTarget(`${path}/${entry.name}`) : null;
      if (target === "dangling") return [];
      const isGap = target === "directory" || target === "unreadable";
      const targetName = target === "file" ? linkRealName(`${path}/${entry.name}`) : null;
      return [
        {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isSymbolicLink: isGap,
          ...(targetName === null ? {} : { targetName }),
        },
      ];
    });
  };

/** Repo-relative paths of the live env files under `root`, and whether the walk saw everything; `read` is the test seam. */
export function listLiveEnvFiles(
  root: string,
  read: DirectoryReader = readFromDisk(root.replace(/\/+$/, "")),
): Listing {
  let complete = true;
  // A directory that is not there is normal; one that exists and cannot be read is a gap the callers must not trust.
  const entriesOf = (dir: string): ReturnType<DirectoryReader> => {
    try {
      return read(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") complete = false;
      return [];
    }
  };
  const dirs = [...DIRECT_DIRECTORIES];
  for (const parent of PARENT_DIRECTORIES) {
    for (const entry of entriesOf(parent)) {
      if (entry.isDirectory) dirs.push(`${parent}/${entry.name}`);
      else if (entry.isSymbolicLink) complete = false;
    }
  }
  if (dirs.length > MAX_DIRECTORIES) complete = false;
  const found = new Set<string>();
  for (const dir of dirs.slice(0, MAX_DIRECTORIES)) {
    for (const entry of entriesOf(dir)) {
      if (entry.isDirectory) continue;
      // A link to a file is judged by its own name and by the name of the file it points at.
      const named = [entry.name, entry.targetName ?? ""].some(
        (name) => ENV_FILE_NAME.test(name) && !TEMPLATE_NAME.test(name),
      );
      if (named) found.add(dir === "" ? entry.name : `${dir}/${entry.name}`);
    }
  }
  return { files: [...found], complete };
}
