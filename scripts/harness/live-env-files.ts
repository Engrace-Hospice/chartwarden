/**
 * The live environment files that exist in the checkout, read from the file system (wave 7, CR5-7).
 * ------------------------------------------------------------------------------------------------
 * A recursive read of a directory (`grep -r`, `cp -r`, `tar c`, `find -exec cat`, `diff -r`) is a secret read when
 * something under it is a live environment file. That used to be a hand-kept list of seven paths, which missed
 * `apps/portal/.env`, `services/<name>/.env`, `apps/web/.env.local` and a root `.env.local`. The question is now asked
 * of the tree: every `.env` or `.env.<suffix>` or `<name>.env` that is not a tracked template (`.example`, `.sample`,
 * `.template`, `.dist`) in the repo root, `deploy/production`, and the direct children of `apps`, `services`,
 * `packages` and `deploy`. Bounded (a few hundred directory reads at most) and read on demand, once per classified
 * command. A file deeper than that is not listed; the fallback list in `secret-reads.ts` and the secret-path rules
 * still name the usual ones. Not pure: it reads the file system (a test passes its own reader).
 */
import { readdirSync } from "node:fs";

/** Directories whose direct children are listed as locations of env files. */
const PARENT_DIRECTORIES: readonly string[] = ["apps", "services", "packages", "deploy"];
/** Directories that are themselves a location. */
const DIRECT_DIRECTORIES: readonly string[] = ["", "deploy/production"];
/** At most this many directories are read in one listing. */
const MAX_DIRECTORIES = 400;

/** `.env`, `.env.local`, `.env.production`, `backend.env`, `.deploy-alert.env`: a live env file by name. */
const ENV_FILE_NAME = /^\.env(?:\.[\w.-]+)?$|^[\w.-]+\.env$/;
/** The tracked templates that sit beside the live files. */
const TEMPLATE_NAME = /\.(?:example|sample|template|dist)$/i;

/** The entries of a directory (repo-relative; `""` is the root), or none when it cannot be read. */
export type DirectoryReader = (
  dir: string,
) => readonly { readonly name: string; readonly isDirectory: boolean }[];

const readFromDisk =
  (root: string): DirectoryReader =>
  (dir) => {
    try {
      return readdirSync(`${root}${dir === "" ? "" : `/${dir}`}`, { withFileTypes: true }).map(
        (entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }),
      );
    } catch {
      return [];
    }
  };

/** Repo-relative paths of the live env files under `root`; `read` is the test seam for the directory reader. */
export function listLiveEnvFiles(
  root: string,
  read: DirectoryReader = readFromDisk(root.replace(/\/+$/, "")),
): string[] {
  const dirs = [...DIRECT_DIRECTORIES];
  for (const parent of PARENT_DIRECTORIES) {
    for (const entry of read(parent)) if (entry.isDirectory) dirs.push(`${parent}/${entry.name}`);
  }
  const found = new Set<string>();
  for (const dir of dirs.slice(0, MAX_DIRECTORIES)) {
    for (const entry of read(dir)) {
      if (entry.isDirectory || !ENV_FILE_NAME.test(entry.name) || TEMPLATE_NAME.test(entry.name)) {
        continue;
      }
      found.add(dir === "" ? entry.name : `${dir}/${entry.name}`);
    }
  }
  return [...found];
}
