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

import {
  GIT_PUSH_LONG_OPTIONS,
  GIT_PUSH_VALUED,
  candidatesOf,
  resolveGitLong,
} from "./git-long-options";
import { globMatches, globTokens } from "./glob";
import { expandBraces } from "./work-budget";

export interface PushFacts {
  /** A force flag: `-f`, `--force`, `--force-with-lease[=…]`, `--force-if-includes`, or a short cluster with an `f`. */
  readonly forced: boolean;
  readonly mirror: boolean;
  readonly all: boolean;
  readonly deleting: boolean;
  /** Each refspec word, decoded and brace-expanded (`+src:dst`, `HEAD`, `:main`), after the remote. */
  readonly refs: readonly string[];
  /**
   * A long option whose abbreviation git would refuse as ambiguous, among whose candidates is one that forces, mirrors, deletes, pushes
   * every branch or names the repository (`--forc`, `--f`, `--d`, `--a`): the guard cannot say which one it is.
   */
  readonly unplacedOption: boolean;
}

const SHORT_FLAG_CLUSTER = /^-[A-Za-z0-9]+$/;
/** `git push` options that take the next word as their value (the short one; the long ones are `GIT_PUSH_VALUED`). */
const VALUE_SHORT_OPTION = /^-o$/;
/** The long options (by their full names) that can force, mirror, delete, push every branch or name the repository. */
const GUARDED_LONG = /^(?:force(?:-with-lease|-if-includes)?|mirror|all|branches|delete|repo)$/;

const decode = (word: string): string => word.replace(/\\(.)/gs, "$1");

/** What one long option word of a push says, read by git's rule (an exact name, else an unambiguous prefix). */
interface LongRead {
  readonly name: string | null;
  readonly unplaced: boolean;
}

function readLong(word: string): LongRead {
  const given = word.slice(2).split("=")[0] ?? "";
  const read = resolveGitLong(GIT_PUSH_LONG_OPTIONS, given);
  if (read === "unknown") {
    // git refuses an option it does not know; a newer git may know a spelling of force this table lacks, so `--force…` stays forced.
    return { name: given.startsWith("force") ? "force" : null, unplaced: false };
  }
  if ("name" in read) return { name: read.name, unplaced: false };
  return { name: null, unplaced: candidatesOf(read).some((c) => GUARDED_LONG.test(c)) };
}

/** Read the words after `git push`. `expand` replaces the variables the command line assigns to a literal. */
export function pushFacts(rest: readonly string[], expand: (text: string) => string): PushFacts {
  const positionals: string[] = [];
  let forced = false;
  let mirror = false;
  let all = false;
  let deleting = false;
  let hasRepo = false;
  let unplacedOption = false;
  let literal = false;
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k] ?? "";
    if (literal || !word.startsWith("-") || word === "-") {
      positionals.push(word);
      continue;
    }
    if (word === "--") literal = true;
    else if (VALUE_SHORT_OPTION.test(word)) k++;
    else if (word.startsWith("--")) {
      const { name, unplaced } = readLong(word);
      unplacedOption ||= unplaced;
      if (name === null) continue;
      if (GIT_PUSH_VALUED.has(name) && !word.includes("=")) k++;
      hasRepo ||= name === "repo";
      if (/^force/.test(name)) forced = true;
      if (name === "mirror") mirror = true;
      if (name === "all" || name === "branches") all = true;
      if (name === "delete") deleting = true;
    } else if (SHORT_FLAG_CLUSTER.test(word)) {
      if (word.includes("f")) forced = true;
      if (word.includes("d")) deleting = true;
    }
  }
  const refs = (hasRepo ? positionals : positionals.slice(1)).flatMap((ref) =>
    expandBraces(decode(ref)).map(expand),
  );
  // A refspec with a leading `+` forces that ref, and one that starts with `:` deletes it, whatever the options say.
  return {
    forced: forced || refs.some((ref) => ref.startsWith("+")),
    mirror,
    all,
    deleting: deleting || refs.some((ref) => ref.startsWith(":")),
    refs,
    unplacedOption,
  };
}

/** The destination text of a refspec as written: `+src:dst` is `dst`, `+main` is `main`, `:main` (a delete) is `main`. */
const rawDestination = (refspec: string): string => {
  const plain = refspec.replace(/^\+/, "");
  const colon = plain.indexOf(":");
  return colon < 0 ? plain : plain.slice(colon + 1);
};

/**
 * Does this refspec push to `main`? git matches a destination against the remote's refs by its ref-name rules, so `main`, `heads/main`
 * and `refs/heads/main` are one ref; a destination with a `*` is a pattern that names every ref it matches (`refs/heads/*:refs/heads/*`
 * pushes main), so it names main when it matches one of those spellings.
 */
function pushesToMain(refspec: string): boolean {
  const destination = rawDestination(refspec);
  const spellings = ["main", "heads/main", "refs/heads/main"];
  if (destination.includes("*")) {
    const tokens = globTokens(destination);
    return spellings.some((name) => globMatches(tokens, name));
  }
  return spellings.includes(destination);
}

const hasExpansion = (text: string): boolean => /[$`]/.test(text);

export type PushFinding =
  | "force-main"
  | "main"
  | "unplaced"
  | "option"
  | "mirror"
  | "all-forced"
  | "tracking-branch"
  | null;

/**
 * What the push can do to `main`, most severe first. `branch` is the checked-out branch when the guard knows it. A forced push of main is
 * `force-main` (the classifier denies it), a push of main `main` (asks), the rest ask for the reason they name.
 */
export function pushFinding(facts: PushFacts, branch: string | undefined): PushFinding {
  const { forced, mirror, all, deleting, refs, unplacedOption } = facts;
  const namesMain = refs.some(pushesToMain);
  const pushesHead = refs.length === 0 || refs.some((ref) => /^\+?HEAD$/.test(ref));
  // A delete of main asks (as before); a forced push of it is refused.
  if (namesMain || (branch === "main" && pushesHead)) return forced ? "force-main" : "main";
  if (mirror) return "mirror";
  if (unplacedOption) return "option";
  if (all && forced) return "all-forced";
  if ((forced || deleting) && refs.some(hasExpansion)) return "unplaced";
  if (forced && pushesHead && branch === undefined) return "tracking-branch";
  return null;
}

const ASK_REASONS: Readonly<Record<Exclude<PushFinding, "force-main" | null>, string>> = {
  main: "Pushing to main auto-deploys and costs a CI matrix run. Confirm the human has approved this push, and that rounds are batched.",
  unplaced:
    "A forced or deleting `git push` names a ref the guard cannot place (a substitution or a variable it does not know): it could be main, which auto-deploys. A human decides.",
  option:
    "A `git push` option is an abbreviation git would refuse as ambiguous, and one of the options it could be forces, mirrors, deletes or pushes every branch (`--forc`, `--d`, `--a`): the guard cannot say which. Spell the option out, or a human decides.",
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
