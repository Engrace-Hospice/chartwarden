/**
 * The commands the project's permission rules ASK about (`.claude/settings.json`: `Bash(git push *)`, `Bash(gh pr merge *)`, `Bash(gh secret *)`),
 * for the spellings those rules do not match (wave 13, A1 and A2: R10-ADV-1, R10-ADV-2). A permission rule matches the command's TEXT, and a shell
 * runs more spellings than the text: macOS is case-insensitive, so `GH pr merge 1` runs `gh`, and a word the shell assembles (`g${X}h pr merge`,
 * `gh pr m\erge`, `gh pr -R x merge`) is `gh pr merge` once it runs. The guard answers the question the rule cannot: is the command the rule asks
 * about, in a spelling the rule does not see? A plain `git -C dir push` is not asked here (Codex has no permission rule, and that spelling is
 * everyday): it stays a residual of the Claude rule. Pure.
 */

/** Why a command the permission rules ask about asks here: its spelling hides it from them. */
export const SPELLING_ASK_REASON = (what: string): string =>
  `\`${what}\` is a command the project's permission rules ask a human about, and this spelling (an upper-case program word, a backslash or an expansion inside a word, an option between the words) is one those rules do not match. A human decides.`;

/** The words of `gh` that name a group and a verb: options dropped (`-R OWNER/REPO` takes a value). */
function optionless(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-R" || a === "--repo") i++;
    else if (!a.startsWith("-")) out.push(a);
  }
  return out;
}

/**
 * What a rule asks about in `prog args`: `git push`, `gh pr merge`, `gh secret`; null for any other command, and for one spelled the way the rule
 * reads it. `gitSub` is git's subcommand after its global options; `typedPlain` says the program word is lower case (the rule matches text).
 */
export function askedBySpelling(
  prog: string,
  args: readonly string[],
  gitSub: string,
  typedPlain: boolean,
): string | null {
  if (prog === "git") return gitSub === "push" && !typedPlain ? "git push" : null;
  if (prog !== "gh") return null;
  const [group, verb] = optionless(args);
  if (group === "secret") return typedPlain && args[0] === "secret" ? null : "gh secret";
  if (group !== "pr" || verb !== "merge") return null;
  return typedPlain && args[0] === "pr" && args[1] === "merge" ? null : "gh pr merge";
}
