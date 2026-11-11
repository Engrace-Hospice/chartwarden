/**
 * `git` subcommands that rewrite the WHOLE working tree, or reach every file in it through a glob or a magic
 * pathspec, so they can silently put back an older, weaker guard (2026-11-10 review, ADV-M6): `git reset --hard
 * <old>`, `git checkout -f`, `git checkout <old-sha>`, `git switch --detach`, `git stash pop`, `git read-tree -u`,
 * `git checkout-index -a -f`, `git cherry-pick`, `git revert`, and `git checkout -- *`.
 *
 * Deliberately NOT here: a plain `git merge`, `git rebase`, `git pull`, `git switch <branch>` and `git checkout
 * <branch>`. They are an everyday part of this repo's work (about 2% of the Bash commands in the sessions
 * measured) and bring in other commits by git's own three-way rules, which never put an older version back over a
 * newer one; PR review and CODEOWNERS are the control for what those commits hold. Their forced spellings
 * (`-X ours|theirs`, `-s ours`) are here. So are not `git rebase --onto` (a routine rebase onto a newer base) and
 * the plain `git stash pop`/`apply` of the top stash (the agent restoring what it just stashed): both are
 * documented gaps, measured at about 0.1% of commands each.
 */

/** `arg` is `--<name>` or an unambiguous abbreviation of it (git accepts any, `--har` for `--hard`). */
const isLongOption = (arg: string, name: string, minChars: number): boolean =>
  arg.startsWith("--") && arg.length >= 2 + minChars && `--${name}`.startsWith(arg);

/** A short-flag cluster (`-fb`) holding `letter`. */
const clusterHas = (arg: string, letter: string): boolean =>
  /^-[A-Za-z]+$/.test(arg) && arg.includes(letter);

/** A ref that is a commit rather than a branch name: a hash, `HEAD~3`, `main^`, `@{1}`, `FETCH_HEAD`. */
const COMMIT_ISH = /^[0-9a-f]{7,40}$|[~^]|@\{|^(?:HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)\b/i;

/** Options of `checkout` and `switch` whose next word is a value, not a ref. */
const BRANCH_VALUE_OPTION = /^(?:-b|-B|-c|-C|--orphan|--conflict|--pathspec-from-file)$/;

/** The words of a `checkout`/`switch` that name a ref (or a path): everything before `--`, minus option values. */
function refWords(rest: readonly string[]): string[] {
  const words: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? "";
    if (a === "--") break;
    if (BRANCH_VALUE_OPTION.test(a)) k++;
    else if (!a.startsWith("-")) words.push(a);
  }
  return words;
}

const STRATEGY_FORCING = /^(?:ours|theirs)$/;

/** A merge, rebase or pull that forces which side wins (`-X theirs`, `-s ours`). */
function forcesAnOutcome(rest: readonly string[]): boolean {
  return rest.some((a, k) => {
    const value = rest[k + 1] ?? "";
    if (a === "-X" || a === "-s" || a === "--strategy" || a === "--strategy-option") {
      return STRATEGY_FORCING.test(value);
    }
    return /^(?:-X|--strategy-option=|-s|--strategy=)(?:ours|theirs)$/.test(a);
  });
}

/** Why this invocation rewrites the whole working tree, or null when it does not (or not in a way worth a prompt). */
export function wholeTreeWriterReason(sub: string, rest: readonly string[]): string | null {
  const flags = rest.filter((a) => a.startsWith("-") && a !== "--");
  if (sub === "reset") {
    const hard = flags.some(
      (a) =>
        isLongOption(a, "hard", 2) || isLongOption(a, "merge", 2) || isLongOption(a, "keep", 2),
    );
    return hard ? "`git reset --hard` rewrites every tracked file in the working tree" : null;
  }
  if (sub === "checkout" || sub === "switch") {
    const forced = flags.some(
      (a) =>
        a === "-f" ||
        isLongOption(a, "force", 2) ||
        isLongOption(a, "discard-changes", 2) ||
        isLongOption(a, "detach", 2) ||
        (sub === "switch" && a === "-d") ||
        (sub === "checkout" && clusterHas(a, "f")),
    );
    if (forced) return `\`git ${sub}\` with a force or detach option rewrites the working tree`;
    // A lone ref is a switch (`git checkout <ref>`); `<tree-ish> <paths>` and anything after `--` restore paths,
    // which the pathspec rules judge.
    const words = refWords(rest);
    const lone = rest.includes("--") || words.length !== 1 ? undefined : words[0];
    return lone !== undefined && COMMIT_ISH.test(lone)
      ? `\`git ${sub}\` to a commit (not a branch) rewrites the working tree`
      : null;
  }
  if (sub === "stash") {
    // The top stash is what the agent itself just stashed (`git stash; ...; git stash pop`); a NAMED, older one
    // (`stash@{3}`) is another session's work, or an old tree.
    const named = rest
      .slice(1)
      .find((a) => !a.startsWith("-") && a !== "stash@{0}" && /^stash@\{|^refs\//.test(a));
    return /^(?:pop|apply|branch)$/.test(rest[0] ?? "") && named !== undefined
      ? "`git stash pop|apply|branch` of an older stash applies saved changes to the working tree"
      : null;
  }
  if (sub === "read-tree") {
    return flags.some((a) => clusterHas(a, "u") || isLongOption(a, "reset", 3))
      ? "`git read-tree -u` rewrites the working tree"
      : null;
  }
  if (sub === "checkout-index") {
    return flags.some(
      (a) =>
        clusterHas(a, "a") ||
        clusterHas(a, "f") ||
        isLongOption(a, "all", 2) ||
        isLongOption(a, "force", 2),
    )
      ? "`git checkout-index -a` / `-f` rewrites files from the index"
      : null;
  }
  if (sub === "cherry-pick" || sub === "revert") {
    return flags.some((a) => /^--(?:abort|quit|continue|skip)$/.test(a))
      ? null
      : `\`git ${sub}\` applies a commit's changes, which may include the guard`;
  }
  if ((sub === "merge" || sub === "rebase" || sub === "pull") && forcesAnOutcome(rest)) {
    return `\`git ${sub}\` with a forced side decides which version of a file wins`;
  }
  return null;
}

/** A pathspec git treats as magic (`:/`, `:(top)`, `:(glob)`): it can name the whole tree from any directory. */
export const isMagicPathspec = (spec: string): boolean => spec.startsWith(":");

/** Does the pathspec hold a wildcard? git's default pathspec `*` also matches across `/`. */
export const hasWildcard = (spec: string): boolean => /[*?[]/.test(spec);
