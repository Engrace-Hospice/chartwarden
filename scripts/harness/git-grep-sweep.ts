/**
 * `git grep` that does not honour .gitignore (wave 4, T2).
 * ----------------------------------------------------------------------------------------
 * `git grep` searches tracked files only, so a live .env (ignored, untracked) is never in it. `--no-index` searches
 * the directory as `grep -r` does, and unless `--exclude-standard` follows it applies no .gitignore; `--untracked
 * --no-exclude-standard` does the same inside a repository. Either reads a live env file that exists, so the
 * classifier judges it like `grep -r` over that directory (`secret-reads.ts`, `reachesLiveEnv`). Pure.
 */

/** `git grep` options (short letters) that take the next word as their value: a pattern, a file, a count. */
export const GIT_GREP_VALUE_LETTERS = "efmABC";
/** `git grep` long options that take the next word as their value. */
export const GIT_GREP_VALUE_LONG =
  /^--(?:max-depth|max-count|threads|context|after-context|before-context|parent-basename)$/;

/** Does `given` (the text after `--`, up to any `=`) spell `name` or an unambiguous prefix of it of `min` characters? */
const spells = (given: string, name: string, min: number): boolean =>
  given.length >= min && name.startsWith(given);

/**
 * Does this `git grep` (`rest` is what follows the subcommand) search without applying .gitignore? The last of
 * `--exclude-standard` and `--no-exclude-standard` wins; `--no-index` defaults to no ignore rules, `--untracked`
 * to the standard ones.
 */
export function gitGrepIgnoresGitignore(rest: readonly string[]): boolean {
  let noIndex = false;
  let untracked = false;
  let excludeStandard: boolean | undefined;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? "";
    if (a === "--") break;
    // `-e --no-index` searches for the text `--no-index`: the word after -e / -f is a value, not an option.
    if (/^-[A-Za-z]*[ef]$/.test(a)) k++;
    if (!a.startsWith("--")) continue;
    const given = a.slice(2, a.indexOf("=") < 0 ? undefined : a.indexOf("="));
    if (spells(given, "no-index", 5)) noIndex = true;
    else if (spells(given, "untracked", 2)) untracked = true;
    else if (spells(given, "no-exclude-standard", 5)) excludeStandard = false;
    else if (spells(given, "exclude-standard", 3)) excludeStandard = true;
  }
  return (noIndex && excludeStandard !== true) || (untracked && excludeStandard === false);
}
