/**
 * A FORCED `git add` (wave 11, part D, D6; round-8 R8-ADV-12). `.gitignore` is what keeps a live environment file out of the object
 * store; `git add -f .env`, `git add --force .`, `git add -A -f`, `git stage -f` and `git update-index --add .env` stage it anyway, and a
 * staged file's content is one `git show :.env` away (and is in `.git` for good, a leak even if the commit is never made). The names the
 * secret-name rule protects are refused here like a read; a forced add of a whole tree (`-A`, `.`) in a tree that holds a live env file asks.
 * This module only reads the command line; the classifier applies its own name and tree rules to the operands. Pure.
 */

import {
  GIT_ADD_LONG_OPTIONS,
  GIT_ADD_VALUED,
  GIT_UPDATE_INDEX_LONG_OPTIONS,
  candidatesOf,
  resolveGitLong,
} from "./git-long-options";

export interface ForcedAdd {
  /** The pathspecs the command stages; `.` when it stages every change (`-A`, `--all`, `-u`) and names none. */
  readonly operands: readonly string[];
  /**
   * The pathspecs come from `--pathspec-from-file SOURCE` (any prefix of the option) and the guard cannot read SOURCE: a forced add, or a
   * source that is standard input, a device or a variable. A source it can place and a plain add are a file read like any other
   * (`file-list-options.ts`).
   */
  readonly pathspecSource?: string;
  /** The add is NOT forced: only `pathspecSource` made it a finding (absent for a forced add). */
  readonly unforced?: true;
}

/** A source of pathspecs the guard cannot read: `-` (standard input), a device, or a name it cannot place. */
const isOpaqueSource = (source: string): boolean =>
  source === "-" || source === "" || /^\/(?:dev|proc)\//.test(source) || /[$`]/.test(source);

/**
 * What the options of an add say, read by git's rule (`git-long-options.ts`: an exact name or an unambiguous prefix, so `--fo` is
 * `--force`). An ambiguous prefix one of whose candidates is the force option, the pathspec file or a stage-everything option cannot
 * be placed and counts as that option (git refuses it, so over-reading costs nothing).
 */
function addOptionsRead(options: readonly string[]): {
  forced: boolean;
  everything: boolean;
  pathspecSource: string | undefined;
} {
  const named = new Set<string>();
  let source: string | undefined;
  options.forEach((word, k) => {
    if (!word.startsWith("--")) return;
    const given = word.slice(2).split("=")[0] ?? "";
    const names = candidatesOf(resolveGitLong(GIT_ADD_LONG_OPTIONS, given));
    for (const name of names) named.add(name);
    if (names.includes("pathspec-from-file"))
      source = word.includes("=") ? word.slice(word.indexOf("=") + 1) : (options[k + 1] ?? "");
  });
  return {
    // `git add` short options are all flags: a cluster holds the force flag when it holds an `f`.
    forced: named.has("force") || options.some((w) => /^-[A-Za-z]*f[A-Za-z]*$/.test(w)),
    everything:
      named.has("all") ||
      named.has("update") ||
      options.some((w) => /^-[A-Za-z]*[Au][A-Za-z]*$/.test(w)),
    pathspecSource: source,
  };
}

/**
 * The pathspec words of `git add` / `git stage` / `git update-index`: everything that is not an option or the value of one that takes a
 * word (`-U N`, `--chmod +x`; a prefix of such an option too, but not an ambiguous one: git refuses it, and reading its next word as a
 * pathspec is the wider reading), and everything after `--`.
 */
function pathspecs(
  rest: readonly string[],
  options: readonly string[] = GIT_ADD_LONG_OPTIONS,
  valued: ReadonlySet<string> = GIT_ADD_VALUED,
): string[] {
  const out: string[] = [];
  let literal = false;
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k] ?? "";
    if (literal) out.push(word);
    else if (word === "--") literal = true;
    else if (options === GIT_ADD_LONG_OPTIONS && word === "-U") k++;
    else if (word.startsWith("--") && !word.includes("=")) {
      const read = resolveGitLong(options, word.slice(2));
      if (read !== "unknown" && "name" in read && valued.has(read.name)) k++;
    } else if (!word.startsWith("-")) out.push(word);
  }
  return out;
}

/**
 * `--cacheinfo MODE,SHA,PATH` (or the older `MODE SHA PATH`) names the PATH it stages after the object: the mode and the sha are no
 * pathspec, the path is.
 */
function withoutCacheinfoObjects(rest: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k] ?? "";
    if (!namesUpdateIndexOption(word, "cacheinfo")) {
      out.push(word);
      continue;
    }
    const attached = word.includes("=");
    const value = attached ? word.slice(word.indexOf("=") + 1) : (rest[k + 1] ?? "");
    if (attached) out.push(value.slice(value.lastIndexOf(",") + 1));
    else if (value.includes(",")) {
      out.push(value.slice(value.lastIndexOf(",") + 1));
      k += 1;
    } else {
      out.push(rest[k + 3] ?? "");
      k += 3;
    }
  }
  return out;
}

/** The forced add this git subcommand is, or null. `rest` are the words after the subcommand. */
export function forcedAdd(sub: string, rest: readonly string[]): ForcedAdd | null {
  if (sub === "add" || sub === "stage") {
    const options = rest.slice(0, rest.indexOf("--") < 0 ? undefined : rest.indexOf("--"));
    const read = addOptionsRead(options);
    const unreadable =
      read.pathspecSource !== undefined && (read.forced || isOpaqueSource(read.pathspecSource));
    if (!read.forced && !unreadable) return null;
    const operands = pathspecs(rest);
    const extra = {
      ...(unreadable ? { pathspecSource: read.pathspecSource } : {}),
      ...(read.forced ? {} : { unforced: true as const }),
    };
    if (operands.length > 0) return { operands, ...extra };
    return read.everything || unreadable ? { operands: ["."], ...extra } : null;
  }
  // `git update-index --add FILE` stages a file whatever `.gitignore` says; `--cacheinfo MODE,SHA,PATH` stages a known object.
  if (sub === "update-index" && updateIndexAdds(rest)) {
    const operands = pathspecs(
      withoutCacheinfoObjects(rest),
      GIT_UPDATE_INDEX_LONG_OPTIONS,
      UPDATE_INDEX_VALUED,
    );
    return operands.length > 0 ? { operands } : null;
  }
  return null;
}

/** The options of `git update-index` that take the next word. */
const UPDATE_INDEX_VALUED: ReadonlySet<string> = new Set(["chmod", "index-version"]);

/** Does this `update-index` word name the option (exactly, or as an unambiguous prefix of it: `--cache`, `--ad`)? */
function namesUpdateIndexOption(word: string, name: string): boolean {
  if (!word.startsWith("--")) return false;
  const given = word.slice(2).split("=")[0] ?? "";
  return candidatesOf(resolveGitLong(GIT_UPDATE_INDEX_LONG_OPTIONS, given)).includes(name);
}

/** Does an `update-index` command line name `--add` (or a prefix of it) before any `--`? */
const updateIndexAdds = (rest: readonly string[]): boolean =>
  rest
    .slice(0, rest.indexOf("--") < 0 ? undefined : rest.indexOf("--"))
    .some((word) => namesUpdateIndexOption(word, "add"));
