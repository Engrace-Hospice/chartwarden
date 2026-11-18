/**
 * Wave 12, G-1 (R9-COMP-9): how a timing test of the shell classifier measures it. The wall-clock bounds of rounds 5 to 7
 * were widened 2.5x to 30x (a 5 s classifier is 1.5 s from the guard's 6.5 s deadline) because a single-shot bound of
 * 100 ms failed under load. The fix is two-sided:
 *
 *   1. The assertion is a COUNT. `classifyBash` charges the characters it judges, the brace alternatives it expands and
 *      the path resolutions it makes against a per-command budget (`work-budget.ts`); those numbers are the same on
 *      every machine and every run, so a rule that judges a text twice, or expands what it should have refused, fails
 *      here without a clock. `measure` returns them next to the verdict.
 *   2. The wall clock stays only as a safety net for what the budget does not count (a lexer, a regular expression): the
 *      best of three runs (the first pays for the JIT, one slow run on a loaded machine is not a regression), against
 *      `netMs(worst)`: twice the worst best-of-three seen in 20 runs on a 14-core machine at twice CPU oversubscription,
 *      never under `NET_FLOOR_MS` (a bound under one scheduler quantum measures the scheduler), and scaled up by
 *      `MACHINE_FACTOR` on a machine slower than the one that was measured (judged by a fixed workload that never
 *      touches the classifier, so a slower classifier cannot pass as a slower machine).
 */
import { classifyBash } from "../../harness/patterns";
import { MAX_COMMAND_JUDGE_MS, refillWork, work } from "../../harness/work-budget";

type Ctx = NonNullable<Parameters<typeof classifyBash>[1]>;
type Verdict = ReturnType<typeof classifyBash>;

/** What one command spent of the per-command budget. */
export interface Spent {
  readonly chars: number;
  readonly braces: number;
  readonly braceChars: number;
  readonly resolutions: number;
  readonly resolutionChars: number;
}

export interface Measured {
  readonly verdict: Verdict;
  readonly spent: Spent;
  /** Some budget ran out (the command asks unless something in it is denied outright). */
  readonly exhausted: boolean;
  /** The judged-text budget or the clock ran out: nothing more was judged. */
  readonly halted: boolean;
  /** Best of three runs, after the verdict run, in milliseconds. */
  readonly ms: number;
}

/** A budget nothing has drawn on: what a command's spending is measured against. */
export const FULL_BUDGET: Spent = (() => {
  refillWork(MAX_COMMAND_JUDGE_MS);
  return {
    chars: work.chars,
    braces: work.braces,
    braceChars: work.braceChars,
    resolutions: work.resolutions,
    resolutionChars: work.resolutionChars,
  };
})();

const RUNS = 3;

function bestOfThree(cmd: string, ctx: Ctx): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < RUNS; run++) {
    const started = performance.now();
    classifyBash(cmd, ctx);
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

/**
 * Judge `cmd` once for the verdict and the counts, then three more times for the clock. The budget is refilled first:
 * a command over the 64 KB cap is refused before `classifyBash` refills it, so without this it would read the previous
 * command's spending.
 */
export function measure(cmd: string, ctx: Ctx): Measured {
  refillWork(MAX_COMMAND_JUDGE_MS);
  const verdict = classifyBash(cmd, ctx);
  const spent: Spent = {
    chars: FULL_BUDGET.chars - work.chars,
    braces: FULL_BUDGET.braces - work.braces,
    braceChars: FULL_BUDGET.braceChars - work.braceChars,
    resolutions: FULL_BUDGET.resolutions - work.resolutions,
    resolutionChars: FULL_BUDGET.resolutionChars - work.resolutionChars,
  };
  const { spent: exhausted, halted } = work;
  return { verdict, spent, exhausted, halted, ms: bestOfThree(cmd, ctx) };
}

/** Below this a wall-clock bound measures the scheduler: the slowest 3 ms shape was 10.9 ms under oversubscription. */
export const NET_FLOOR_MS = 20;

/**
 * How fast this machine runs a fixed piece of string and regular-expression work that does not touch the classifier (so
 * a slower CLASSIFIER cannot hide as a slower machine), best of five.
 */
const REFERENCE_TEXT = "ab/cd e*f{g,h} [x-z]? $(a) ".repeat(25_000);
const REFERENCE_RUNS = 5;
const referenceWork = (): number => {
  let h = 0;
  for (const word of REFERENCE_TEXT.split(" ")) {
    h = (h * 31 + word.length + word.charCodeAt(0)) | 0;
    if (/^[a-z]+\/[a-z]+$/.test(word)) h++;
    if (word.includes("{") && word.replace(/[{}]/g, "").split(",").length > 1) h++;
  }
  return h;
};
/** What `referenceWork` took on the machine the bounds were measured on, idle, best of five, under vitest on node. */
const REFERENCE_MS_WHEN_MEASURED = 5.5;

/** How much slower this machine runs than the one the bounds were measured on, never below 1 (a faster one keeps them). */
export const MACHINE_FACTOR: number = Math.max(
  1,
  (() => {
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < REFERENCE_RUNS; run++) {
      const started = performance.now();
      referenceWork();
      best = Math.min(best, performance.now() - started);
    }
    return best / REFERENCE_MS_WHEN_MEASURED;
  })(),
);

/** The safety-net bound for a shape whose worst best-of-three was `worstMs` in 20 loaded runs: twice it, with the floor. */
export const netMs = (worstMs: number): number =>
  Math.max(NET_FLOOR_MS, 2 * worstMs) * MACHINE_FACTOR;
