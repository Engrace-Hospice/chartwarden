/**
 * A FORCED `git add` (wave 11, part D, D6; round-8 R8-ADV-12). `.gitignore` is what keeps a live environment file out of the object
 * store; `git add -f .env`, `git add --force .`, `git add -A -f`, `git stage -f` and `git update-index --add .env` stage it anyway, and a
 * staged file's content is one `git show :.env` away (and is in `.git` for good, a leak even if the commit is never made). The names the
 * secret-name rule protects are refused here like a read; a forced add of a whole tree (`-A`, `.`) in a tree that holds a live env file asks.
 * This module only reads the command line; the classifier applies its own name and tree rules to the operands. Pure.
 */

export interface ForcedAdd {
  /** The pathspecs the command stages; `.` when it stages every change (`-A`, `--all`, `-u`) and names none. */
  readonly operands: readonly string[];
}

/** `git add` short options are all flags: a cluster holds the force flag when it holds an `f`. */
const isForceOption = (word: string): boolean =>
  word === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(word);

const STAGES_EVERYTHING = (word: string): boolean =>
  word === "--all" || word === "--update" || /^-[A-Za-z]*[Au][A-Za-z]*$/.test(word);

/** The pathspec words of `git add` / `git stage`: everything that is not an option, and everything after `--`. */
function pathspecs(rest: readonly string[]): string[] {
  const out: string[] = [];
  let literal = false;
  for (const word of rest) {
    if (literal) out.push(word);
    else if (word === "--") literal = true;
    else if (!word.startsWith("-")) out.push(word);
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
    if (word !== "--cacheinfo") {
      out.push(word);
      continue;
    }
    const value = rest[k + 1] ?? "";
    if (value.includes(",")) {
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
    if (!options.some(isForceOption)) return null;
    const operands = pathspecs(rest);
    if (operands.length > 0) return { operands };
    return options.some(STAGES_EVERYTHING) ? { operands: ["."] } : null;
  }
  // `git update-index --add FILE` stages a file whatever `.gitignore` says; `--cacheinfo MODE,SHA,PATH` stages a known object.
  if (sub === "update-index" && rest.includes("--add")) {
    const operands = pathspecs(withoutCacheinfoObjects(rest));
    return operands.length > 0 ? { operands } : null;
  }
  return null;
}
