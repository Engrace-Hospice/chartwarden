/**
 * What ONE command may spend in the classifier, and the brace and path helpers whose cost it bounds.
 *
 * The 64 KB cap bounds the text, not the work: 1,300 words that each expand to 256 brace alternatives, judged
 * against 16 candidate directories, are five million path resolutions (12 s), and a hook that is killed at its
 * timeout is refused (the guard's own 6.5 s deadline now answers first). So brace alternatives and path resolutions draw on a budget that `classifyBash`
 * refills for each command and that every nested `$( )` and `bash -c` shares, counted in ITEMS and in
 * CHARACTERS (one 4,000-character word expanded 4,096 ways is as costly as 4,096 times more words). Past it
 * nothing more is expanded or resolved (a resolution answers "unknown directory"), and the command asks, but
 * what a cheap check can still find stands: a budget never turns a deny into an ask.
 */

/**
 * Alternatives one word may expand to: the per-command cap, so that one word is not cut earlier than the command is (a
 * cut makes the command ask, and a cut that falls before a real name turns a deny into an ask). Eleven two-way groups are
 * 2,048 alternatives; a name that needs a mix of first and last alternatives is found for any word up to this size.
 */
const MAX_BRACE_ALTERNATIVES = 4096;
/** The text one word's alternatives may add up to: a long word keeps a smaller cap, so one word never costs a second. */
const MAX_WORD_ALTERNATIVE_CHARS = 1024 * 1024;
const MIN_BRACE_ALTERNATIVES = 256;
const alternativeCap = (word: string): number =>
  Math.min(
    MAX_BRACE_ALTERNATIVES,
    Math.max(
      MIN_BRACE_ALTERNATIVES,
      Math.floor(MAX_WORD_ALTERNATIVE_CHARS / Math.max(word.length, 1)),
    ),
  );
const MAX_BRACE_GROUPS = 16;
/** Brace alternatives, and the characters they hold, one command may produce. */
const MAX_COMMAND_BRACE_ALTERNATIVES = 4096;
const MAX_COMMAND_BRACE_CHARS = 8 * 1024 * 1024;
/** Path resolutions, and the characters they walk, one command may spend (a `cd` is charged for characters only). */
const MAX_COMMAND_PATH_RESOLUTIONS = 16_384;
const MAX_COMMAND_RESOLUTION_CHARS = 8 * 1024 * 1024;
/** Text judged across the command and everything nested in it (`$( )`, `bash -c`, `eval`): four times the 64 KB command cap. */
const MAX_COMMAND_JUDGED_CHARS = 256 * 1024;
/** A word longer than a path can be (PATH_MAX) is not a file name, so its braces are not expanded. */
export const MAX_BRACE_WORD_CHARS = 4096;
/** Characters the cheap fallback reading of ONE word may produce (a 60 KB word of alternatives would otherwise be gigabytes). */
const MAX_FALLBACK_CHARS = 1024 * 1024;
/** Groups the all-first / all-last reading follows: one linear scan each, so a few dozen cost nothing. */
const MAX_EDGE_GROUPS = 64;
/**
 * Wall-clock backstop for one `classifyBash`. The guard has a hard deadline of its own (`hard-deadline.ts`); this
 * is the earlier, politer one, and it judges a command twice when the root or cwd is a symlink.
 */
export const MAX_COMMAND_JUDGE_MS = 1000;

export interface Work {
  braces: number;
  braceChars: number;
  resolutions: number;
  resolutionChars: number;
  chars: number;
  deadline: number;
  /** Some budget ran out: the command asks unless something in it is denied outright. */
  spent: boolean;
  /** The clock or the judged-text budget ran out: nothing more is judged (every further judging is costly). */
  halted: boolean;
  /**
   * Does the command line being judged hold a brace group the SHELL would expand (an unquoted `{a,b}` or `{a..b}`)?
   * Set per simple command by the classifier from the lexer (`bare-braces.ts`); true until then. A word the budget cuts
   * spends the budget only when it did: a quoted `{"a":1,"b":2}` in an inline script is not a finding, and whitespace in
   * the word never says so (`{c,'x y'}` is a bare group whose alternative holds a quoted space).
   */
  bareBraces: boolean;
}

const freshWork = (limitMs: number): Work => ({
  braces: MAX_COMMAND_BRACE_ALTERNATIVES,
  braceChars: MAX_COMMAND_BRACE_CHARS,
  resolutions: MAX_COMMAND_PATH_RESOLUTIONS,
  resolutionChars: MAX_COMMAND_RESOLUTION_CHARS,
  chars: MAX_COMMAND_JUDGED_CHARS,
  deadline: performance.now() + limitMs,
  spent: false,
  halted: false,
  bareBraces: true,
});

/** The current command's budget; `refillWork` replaces it, so read it through this binding. */
export let work: Work = freshWork(MAX_COMMAND_JUDGE_MS);
export const refillWork = (limitMs: number): void => {
  work = freshWork(limitMs);
};

/** Has this command used up its time or its judged text? Marks the budget spent, so the command asks. */
export function halted(): boolean {
  if (!work.halted && performance.now() > work.deadline) {
    work.halted = true;
    work.spent = true;
  }
  return work.halted;
}

/** Charge `n` characters of text about to be judged (a nested command is judged whole again). */
export function spendJudgedChars(n: number): void {
  work.chars -= n;
  if (work.chars < 0) {
    work.spent = true;
    work.halted = true;
  }
}

/**
 * Charge one path resolution of `chars` characters; false when the budget is gone (the caller answers "unknown
 * directory"). A `strict` one (a `cd`) resolves against at most 16 directories and is charged for characters
 * only: a chain of them is linear, but a `git -C` chain of long operands is not.
 */
export function spendResolution(chars: number, strict: boolean): boolean {
  work.resolutionChars -= chars;
  if (!strict) work.resolutions--;
  if (work.resolutionChars < 0 || work.resolutions < 0) {
    work.spent = true;
    return false;
  }
  return true;
}

/** A `{a..b}` or `{a..b..step}` body: two integers or two single letters, and an optional integer step. */
const SEQUENCE = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/;
const isSequence = (body: string): boolean => SEQUENCE.test(body);
/** The most items one sequence expands to. */
const MAX_SEQUENCE_ITEMS = 256;

/** The alternatives of a brace body: its comma-separated parts, or the items of a sequence (`E..E` is `E`, `1..3` is `1 2 3`). */
function alternativesOf(body: string): string[] {
  const m = SEQUENCE.exec(body);
  if (!m) return body.split(",");
  const [, from, to, step] = m as unknown as [string, string, string, string | undefined];
  const numeric = /^-?\d+$/.test(from) && /^-?\d+$/.test(to);
  if (!numeric && (/\d/.test(from) || /\d/.test(to))) return body.split(",");
  const a = numeric ? Number(from) : from.charCodeAt(0);
  const b = numeric ? Number(to) : to.charCodeAt(0);
  const by = Math.max(Math.abs(Number(step ?? 1)), 1) * (b >= a ? 1 : -1);
  const out: string[] = [];
  for (let n = a; (by > 0 ? n <= b : n >= b) && out.length < MAX_SEQUENCE_ITEMS; n += by) {
    out.push(numeric ? String(n) : String.fromCharCode(n));
  }
  return out;
}

/**
 * The first `{a,b}` group in `word` that has no brace inside it, split into the text before, its body and
 * the text after; null when there is none. One pass: a regex for this backtracks quadratically on `{,,,,`.
 */
function firstBraceGroup(word: string): { pre: string; body: string; post: string } | null {
  let open = -1;
  let comma = false;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (ch === "{") {
      open = i;
      comma = false;
    } else if (ch === ",") comma ||= open >= 0;
    else if (ch === "}") {
      if (open >= 0 && (comma || isSequence(word.slice(open + 1, i)))) {
        return { pre: word.slice(0, open), body: word.slice(open + 1, i), post: word.slice(i + 1) };
      }
      open = -1;
      comma = false;
    }
  }
  return null;
}

/**
 * What a word still reads as when each of its brace groups is expanded ALONE, the others left as written: a
 * linear fallback for a word the budget no longer lets expand fully. `.en{v,}` is `.env` however many other
 * groups the command spent the budget on; a name that needs two groups at once is found only inside the budget.
 */
function singleGroupAlternatives(word: string): string[] {
  const out: string[] = [];
  let room = MAX_FALLBACK_CHARS;
  let from = 0;
  for (let group = 0; group < MAX_BRACE_GROUPS && room > 0; group++) {
    const found = firstBraceGroup(word.slice(from));
    if (!found) break;
    const pre = word.slice(0, from + found.pre.length);
    const post = found.post;
    for (const alternative of alternativesOf(found.body)) {
      if (room <= 0) break;
      out.push(`${pre}${alternative}${post}`);
      room -= pre.length + alternative.length + post.length;
    }
    from += found.pre.length + found.body.length + 2;
  }
  return out;
}

/**
 * The word with EVERY group (up to 64) taking its first alternative, and with every group taking its last. The cap on
 * alternatives keeps the first few hundred combinations, and an attacker orders a group's alternatives so that the
 * real name is the one that is cut: `~/.aws/{x,}{x,}…credentials` is `~/.aws/credentials` only when each group
 * takes its (empty) last alternative.
 */
function edgeAlternatives(word: string): string[] {
  const pick = (last: boolean): string => {
    let w = word;
    for (let group = 0; group < MAX_EDGE_GROUPS; group++) {
      const found = firstBraceGroup(w);
      if (!found) break;
      const alternatives = alternativesOf(found.body);
      const chosen = last ? alternatives[alternatives.length - 1] : alternatives[0];
      w = `${found.pre}${chosen ?? ""}${found.post}`;
    }
    return w;
  };
  return [pick(false), pick(true)];
}

/** What a word the budget will not expand fully still reads as: each group alone, and all-first / all-last. */
const cheapAlternatives = (word: string): string[] => [
  ...singleGroupAlternatives(word),
  ...edgeAlternatives(word),
];

/**
 * A word the budget could not expand fully spends it (the command asks) when the shell would really have expanded a brace
 * group of the command: a word cut while the command holds no UNQUOTED group (`python3 -c '… {"a":1,"b":2} …'`, a long
 * JSON body) is quoted text, and an inline script that holds a few object literals is not a finding. The cheap reading
 * (each group alone, all-first, all-last) still runs for it, and a protected name it finds is still a deny or an ask.
 */
function spendIfShellWouldExpand(_word: string): void {
  if (work.bareBraces) work.spent = true;
}

/** Say whether the command line about to be judged holds a brace group the shell would expand (`bare-braces.ts`). */
export const setBareBraces = (value: boolean): void => {
  work.bareBraces = value;
};

/** Bash brace expansion of one word: `.en{v,}` is `.env` and `.en`. Bounded, so it cannot be made to blow up. */
export function expandBraces(word: string): string[] {
  // The command holds no group the shell would expand (every brace is quoted or escaped): the word stays as written.
  if (!work.bareBraces) return [word];
  if (word.length > MAX_BRACE_WORD_CHARS) {
    // Not a file name, so not expanded; but a group in it may still read as a protected name through one alternative
    // (`cat {<secret>,<4,100 characters>}`), so the command asks and the cheap reading below can still deny.
    if (firstBraceGroup(word) === null) return [word];
    spendIfShellWouldExpand(word);
    return [word, ...cheapAlternatives(word)];
  }
  let out = [word];
  let cut = false;
  for (let round = 0; round < MAX_BRACE_GROUPS; round++) {
    const next: string[] = [];
    let changed = false;
    let capped = false;
    for (const w of out) {
      // Past the cap the rest of the round is carried as written, unscanned: the cap is also the cost bound.
      const group = capped ? null : firstBraceGroup(w);
      if (!group) {
        next.push(w);
        continue;
      }
      if (next.length >= alternativeCap(word)) {
        capped = true;
        cut = true; // the cap leaves this group unexpanded: the command asks, and the cheap reading still denies
        next.push(w);
        continue;
      }
      if (work.braces <= 0 || work.braceChars <= 0) {
        spendIfShellWouldExpand(w); // a group is left unexpanded: the command asks, and the cheap reading below still denies
        next.push(w, ...singleGroupAlternatives(w));
        continue;
      }
      changed = true;
      const alternatives = alternativesOf(group.body);
      work.braces -= alternatives.length;
      work.braceChars -= alternatives.length * w.length;
      for (const alt of alternatives) next.push(`${group.pre}${alt}${group.post}`);
    }
    out = next;
    if (!changed) break;
  }
  if (!cut) return out;
  spendIfShellWouldExpand(word);
  return [...out, ...cheapAlternatives(word)];
}

/** `p` without its trailing slashes (and a trailing `/.`): `src/`, `src//` and `src/.` are `src`. Linear. */
function withoutTrailingSlashes(p: string): string {
  let end = p.length;
  const dot = end > 0 && p[end - 1] === ".";
  let probe = dot ? end - 1 : end;
  while (probe > 0 && p[probe - 1] === "/") probe--;
  // A bare `.` or `a.` has no slash before the dot: it is a name, not a trailing `/.`.
  if (probe < (dot ? end - 1 : end)) end = probe;
  return p.slice(0, end);
}

/** The last component of a path: `a/b/` and `a/b/.` are `b`. Linear: a regex for this is quadratic on a run of `/`. */
export function baseName(p: string): string {
  const trimmed = withoutTrailingSlashes(p);
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** `p` without trailing slashes. Linear, for the same reason. */
export function trimSlashes(p: string): string {
  let end = p.length;
  while (end > 0 && p[end - 1] === "/") end--;
  return end === p.length ? p : p.slice(0, end);
}
