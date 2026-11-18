/**
 * The long options of `git push`, `git add` and `git update-index`, and the rule git reads them by (wave 12, part F, F-4 and F-5; round-9
 * R9-ADV-8, R9-ADV-19, R9-CR-5, R9-CR-6; rule 12 and W11).
 * ------------------------------------------------------------------------------------------------
 * git's own parser (parse-options.c) takes an exact long option, else an UNAMBIGUOUS PREFIX of one: `git add --fo <file>` is `--force`,
 * `git push --mir` is `--mirror`, `git push --del` is `--delete`; a prefix of two or more options (`git push --forc`: `--force`,
 * `--force-with-lease`, `--force-if-includes`) is refused with "ambiguous option". The rules that read a push or an add compared the exact
 * spelling only, so every shortened spelling passed. This module holds the option names recorded from the installed git
 * (`fixtures/harness-db-tool-options/git/`, `helpers/record-git-options.ts`: git 2.53.0; a no-tool test compares every recorded prefix with
 * `resolveGitLong`, and a live test re-records a sample) and resolves a prefix by git's rule. `--[no-]x` options appear as `x` and `no-x`;
 * the two hidden `git add` names (`--warn-embedded-repo`, `--no-warn-embedded-repo`) were found by the prefix probe, not by `-h`. Pure.
 */

export type GitLongRead =
  | { readonly name: string }
  | { readonly ambiguous: readonly string[] }
  | "unknown";

/** Resolve the text after `--` (up to any `=`): an exact name, else the one option it is a prefix of. */
export function resolveGitLong(options: readonly string[], given: string): GitLongRead {
  if (given === "") return "unknown";
  if (options.includes(given)) return { name: given };
  const candidates = options.filter((name) => name.startsWith(given));
  const [only] = candidates;
  if (only !== undefined && candidates.length === 1) return { name: only };
  return candidates.length === 0 ? "unknown" : { ambiguous: candidates };
}

/** The options a read may stand for: the one option, or every candidate of an ambiguous prefix; none for an unknown one. */
export const candidatesOf = (read: GitLongRead): readonly string[] =>
  read === "unknown" ? [] : "name" in read ? [read.name] : read.ambiguous;

/** Every long option of `git push` (positive and `no-` forms). */
export const GIT_PUSH_LONG_OPTIONS: readonly string[] = [
  "all",
  "atomic",
  "branches",
  "delete",
  "dry-run",
  "exec",
  "follow-tags",
  "force",
  "force-if-includes",
  "force-with-lease",
  "ipv4",
  "ipv6",
  "mirror",
  "no-all",
  "no-atomic",
  "no-branches",
  "no-delete",
  "no-dry-run",
  "no-exec",
  "no-follow-tags",
  "no-force",
  "no-force-if-includes",
  "no-force-with-lease",
  "no-mirror",
  "no-porcelain",
  "no-progress",
  "no-prune",
  "no-push-option",
  "no-quiet",
  "no-receive-pack",
  "no-recurse-submodules",
  "no-repo",
  "no-set-upstream",
  "no-signed",
  "no-tags",
  "no-thin",
  "no-verbose",
  "no-verify",
  "porcelain",
  "progress",
  "prune",
  "push-option",
  "quiet",
  "receive-pack",
  "recurse-submodules",
  "repo",
  "set-upstream",
  "signed",
  "tags",
  "thin",
  "verbose",
  "verify",
];

/** The `git push` options that take the next word as their value (`--repo origin`); the `no-` forms take none. */
export const GIT_PUSH_VALUED: ReadonlySet<string> = new Set([
  "exec",
  "push-option",
  "receive-pack",
  "recurse-submodules",
  "repo",
]);

/** Every long option of `git add` and `git stage` (positive and `no-` forms, the hidden `warn-embedded-repo` included). */
export const GIT_ADD_LONG_OPTIONS: readonly string[] = [
  "all",
  "chmod",
  "dry-run",
  "edit",
  "force",
  "ignore-errors",
  "ignore-missing",
  "ignore-removal",
  "intent-to-add",
  "inter-hunk-context",
  "interactive",
  "no-all",
  "no-chmod",
  "no-dry-run",
  "no-edit",
  "no-force",
  "no-ignore-errors",
  "no-ignore-missing",
  "no-ignore-removal",
  "no-intent-to-add",
  "no-interactive",
  "no-patch",
  "no-pathspec-file-nul",
  "no-pathspec-from-file",
  "no-refresh",
  "no-renormalize",
  "no-sparse",
  "no-update",
  "no-verbose",
  "no-warn-embedded-repo",
  "patch",
  "pathspec-file-nul",
  "pathspec-from-file",
  "refresh",
  "renormalize",
  "sparse",
  "unified",
  "update",
  "verbose",
  "warn-embedded-repo",
];

/** The `git add` options that take the next word as their value. */
export const GIT_ADD_VALUED: ReadonlySet<string> = new Set([
  "chmod",
  "inter-hunk-context",
  "pathspec-from-file",
  "unified",
]);

/** Every long option of `git update-index` (positive and `no-` forms). */
export const GIT_UPDATE_INDEX_LONG_OPTIONS: readonly string[] = [
  "add",
  "again",
  "assume-unchanged",
  "cacheinfo",
  "chmod",
  "clear-resolve-undo",
  "force-remove",
  "force-untracked-cache",
  "force-write-index",
  "fsmonitor",
  "fsmonitor-valid",
  "ignore-missing",
  "ignore-skip-worktree-entries",
  "ignore-submodules",
  "index-info",
  "index-version",
  "info-only",
  "no-add",
  "no-assume-unchanged",
  "no-force-remove",
  "no-force-untracked-cache",
  "no-force-write-index",
  "no-fsmonitor",
  "no-fsmonitor-valid",
  "no-ignore-missing",
  "no-ignore-skip-worktree-entries",
  "no-ignore-submodules",
  "no-index-version",
  "no-info-only",
  "no-remove",
  "no-replace",
  "no-show-index-version",
  "no-skip-worktree",
  "no-split-index",
  "no-test-untracked-cache",
  "no-unmerged",
  "no-untracked-cache",
  "no-verbose",
  "really-refresh",
  "refresh",
  "remove",
  "replace",
  "show-index-version",
  "skip-worktree",
  "split-index",
  "stdin",
  "test-untracked-cache",
  "unmerged",
  "unresolve",
  "untracked-cache",
  "verbose",
];
