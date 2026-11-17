/**
 * What a `git push` command line pushes, and whether it can reach `main` (wave 11, part D, D7; round-8 R8-CR-7).
 * ------------------------------------------------------------------------------------------------
 * The rule compared `main` as a literal regular expression over the typed word, so `git push --force origin main$(true)`,
 * `"main$EMPTY"`, `main${EMPTY}`, `ma\in`, `$(echo main)`, `$BR` all pushed main past it, and so did a force flag in a cluster
 * (`-fu`), `--mirror`, `--all -f`, and `git push -f` with no ref (it pushes the tracking branch). Now:
 *
 *   - a refspec is DECODED before it is compared (backslashes removed; a variable the command line assigns to a literal is replaced);
 *   - a refspec that still holds an expansion the guard cannot place, in a force, mirror or delete push, asks;
 *   - a force flag is any `--force*` option or a short cluster that holds `f` (`-fu`, `-uf`), and `-o VALUE`/`--push-option` skip their value;
 *   - `--mirror`, and `--all` with a force flag, ask (they push or overwrite every branch, `main` included);
 *   - a forced push with no ref or only `HEAD` pushes the current branch to its upstream: when the branch is `main` that is main, and
 *     when the guard does not know the branch it asks.
 * The verdicts (deny a forced push of main, ask for a push of main) are the classifier's; this module reads the command line. Pure.
 */

export interface PushFacts {
  /** A force flag: `-f`, `--force`, `--force-with-lease[=…]`, `--force-if-includes`, or a short cluster with an `f`. */
  readonly forced: boolean;
  readonly mirror: boolean;
  readonly all: boolean;
  readonly deleting: boolean;
  /** Each refspec word, decoded (`+src:dst`, `HEAD`, `:main`), after the remote. */
  readonly refs: readonly string[];
}

const SHORT_FLAG_CLUSTER = /^-[A-Za-z0-9]+$/;
/** `git push` options that take the next word as their value. */
const VALUE_OPTION = /^(?:-o|--push-option|--repo|--receive-pack|--exec)$/;

const decode = (word: string): string => word.replace(/\\(.)/gs, "$1");

/** Read the words after `git push`. `expand` replaces the variables the command line assigns to a literal. */
export function pushFacts(rest: readonly string[], expand: (text: string) => string): PushFacts {
  const positionals: string[] = [];
  let forced = false;
  let mirror = false;
  let all = false;
  let deleting = false;
  let hasRepo = false;
  let literal = false;
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k] ?? "";
    if (literal || !word.startsWith("-") || word === "-") {
      positionals.push(word);
      continue;
    }
    if (word === "--") literal = true;
    else if (VALUE_OPTION.test(word)) {
      hasRepo ||= word === "--repo";
      k++;
    } else if (word.startsWith("--")) {
      const name = word.slice(2).split("=")[0] ?? "";
      if (name === "repo") hasRepo = true;
      if (name.startsWith("force")) forced = true;
      if (name === "mirror") mirror = true;
      if (name === "all" || name === "branches") all = true;
      if (name === "delete") deleting = true;
    } else if (SHORT_FLAG_CLUSTER.test(word)) {
      if (word.includes("f")) forced = true;
      if (word.includes("d")) deleting = true;
    }
  }
  const refs = (hasRepo ? positionals : positionals.slice(1)).map((ref) => expand(decode(ref)));
  // A refspec with a leading `+` forces that ref, and one that starts with `:` deletes it, whatever the options say.
  return {
    forced: forced || refs.some((ref) => ref.startsWith("+")),
    mirror,
    all,
    deleting: deleting || refs.some((ref) => ref.startsWith(":")),
    refs,
  };
}

/** The ref a refspec pushes to: `+src:dst` is `dst`, `+main` is `main`, `:main` (a delete) is `main`. */
const destinationOf = (refspec: string): string => {
  const plain = refspec.replace(/^\+/, "");
  const colon = plain.indexOf(":");
  return (colon < 0 ? plain : plain.slice(colon + 1)).replace(/^refs\/heads\//, "");
};

const hasExpansion = (text: string): boolean => /[$`]/.test(text);

export type PushFinding =
  | "force-main"
  | "main"
  | "unplaced"
  | "mirror"
  | "all-forced"
  | "tracking-branch"
  | null;

/**
 * What the push can do to `main`, most severe first. `branch` is the checked-out branch when the guard knows it. A forced push of main is
 * `force-main` (the classifier denies it), a push of main `main` (asks), the rest ask for the reason they name.
 */
export function pushFinding(facts: PushFacts, branch: string | undefined): PushFinding {
  const { forced, mirror, all, deleting, refs } = facts;
  const namesMain = refs.some((ref) => destinationOf(ref) === "main");
  const pushesHead = refs.length === 0 || refs.some((ref) => /^\+?HEAD$/.test(ref));
  // A delete of main asks (as before); a forced push of it is refused.
  if (namesMain || (branch === "main" && pushesHead)) return forced ? "force-main" : "main";
  if (mirror) return "mirror";
  if (all && forced) return "all-forced";
  if ((forced || deleting) && refs.some(hasExpansion)) return "unplaced";
  if (forced && pushesHead && branch === undefined) return "tracking-branch";
  return null;
}

const ASK_REASONS: Readonly<Record<Exclude<PushFinding, "force-main" | null>, string>> = {
  main: "Pushing to main auto-deploys and costs a CI matrix run. Confirm the human has approved this push, and that rounds are batched.",
  unplaced:
    "A forced or deleting `git push` names a ref the guard cannot place (a substitution or a variable it does not know): it could be main, which auto-deploys. A human decides.",
  mirror:
    "`git push --mirror` overwrites every ref of the remote, main included, and deletes the ones this clone lacks. A human decides.",
  "all-forced":
    "`git push --all --force` overwrites every branch of the remote, main included. A human decides.",
  "tracking-branch":
    "A forced `git push` with no ref pushes the current branch to its upstream, and the guard does not know which branch that is: it could be main. Name the branch, or a human decides.",
};

const FORCE_MAIN_REASON =
  "Force-pushing main rewrites the change record (see audit/FORCE_PUSH_RECOVERY_AUDIT_2026-09-25.md).";

/** The decision and reason for a finding. */
export function pushDecision(finding: Exclude<PushFinding, null>): {
  readonly decision: "ask" | "deny";
  readonly reason: string;
} {
  return finding === "force-main"
    ? { decision: "deny", reason: FORCE_MAIN_REASON }
    : { decision: "ask", reason: ASK_REASONS[finding] };
}
