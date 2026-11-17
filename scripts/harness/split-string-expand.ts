/**
 * `env -S STRING`: the words env makes of the string take the place of the option, and env goes on reading OPTIONS over them
 * (wave 12 part E1, E1-2; round-9 R9-ADV-3, a pre-existing hole of wave 10 that wave 11 left open).
 * -----------------------------------------------------------------------------------------------------------------------------------
 * Wave 11 split the string by env's own grammar and spliced the words in as the COMMAND, so `env -S '-i CMD'`, `-S '-u X CMD'`, `-S '-C dir CMD'`,
 * `-S '-P dir CMD'`, `-S '-- CMD'`, `-S '-S CMD'`, `env -S '-i' CMD` and `env -i -S '-u X CMD'` judged `-i` (or `-u`) as the program and never
 * CMD. The installed env (BSD, macOS) reads the split words as if they had been typed where `-S STRING` stood: options in them are env's own
 * options (probed with `env -S '-i echo HIT'`, `-S '-u X echo HIT'`, `-S '-C /tmp echo HIT'`, `-S '-- echo HIT'`, `-S '-S echo HIT'`, `-S '-i'
 * echo HIT`, `-i -S '-u X echo HIT'`; a NAME=value word ends the options, so `-S 'A=b -i echo HIT'` runs `-i`). This module rewrites the word list
 * the same way, round after round, until no `-S` option is left; the caller then reads the options of the rewritten words once, as for any
 * wrapper. A string it cannot place, or nested deeper than `MAX_SPLIT_ROUNDS`, is reported as `unplaced` and the guard asks. Pure.
 */
import type { EnvSplit } from "./env-split";
import { readOptions } from "./option-grammar";
import type { WrapperSpec } from "./wrapper-specs";

/** `env -S '-S -S -S …'` nests the string reader; more rounds than this is never a real command line. */
const MAX_SPLIT_ROUNDS = 8;

export interface Expanded {
  /** The wrapper's words with every `-S STRING` replaced by the words of the string. */
  readonly words: readonly string[];
  /** The same, in the reading the programs are handed (`undefined`: the same text; `null`: the indices were lost). */
  readonly handed: readonly string[] | null | undefined;
  readonly unplaced?: string;
}

/** The words an option occupies in `word`, and the part of a short cluster that stays (`-iS` leaves `-i`). */
function occupied(
  word: string,
  shortName: string | undefined,
): { keep: string[]; attached: boolean } {
  if (word.startsWith("--")) return { keep: [], attached: word.includes("=") };
  const letter = shortName === undefined ? 1 : Math.max(1, word.indexOf(shortName, 1));
  return { keep: letter > 1 ? [word.slice(0, letter)] : [], attached: letter + 1 < word.length };
}

/**
 * `words` (the wrapper at `at`) with every split option replaced by the split words, or `undefined` when there is none. `handed` follows the
 * words round by round; a reading that cannot keep the two in step makes the string unplaced, not guessed.
 */
export function expandSplits(
  spec: WrapperSpec,
  words: readonly string[],
  at: number,
  split: (text: string) => EnvSplit,
  handed: readonly string[] | null | undefined,
): Expanded | undefined {
  const names = spec.splits ?? [];
  let w = [...words];
  let h = handed === null || handed === undefined ? handed : [...handed];
  let unplaced: string | undefined;
  let changed = false;
  for (let round = 0; round <= MAX_SPLIT_ROUNDS; round++) {
    const found = readOptions(spec.grammar, w, at + 1).options.find((o) => names.includes(o.name));
    if (found === undefined)
      return changed
        ? { words: w, handed: h, ...(unplaced === undefined ? {} : { unplaced }) }
        : undefined;
    changed = true;
    if (round === MAX_SPLIT_ROUNDS)
      return { words: w, handed: h, unplaced: "-S string nested too deep to read" };
    const seen =
      h === undefined || h === null
        ? undefined
        : readOptions(spec.grammar, h, at + 1).options.find(
            (o) => o.at === found.at && names.includes(o.name),
          );
    if (h === null || (h !== undefined && seen === undefined) || found.value === undefined) {
      return { words: w, handed: h, unplaced: "-S string" };
    }
    const result = split(seen?.value ?? found.value);
    unplaced ??= result.unplaced;
    const here = occupied(w[found.at] as string, found.name.length === 1 ? found.name : undefined);
    const to = found.at + (here.attached ? 1 : 2);
    const put = (list: readonly string[]): string[] => [
      ...list.slice(0, found.at),
      ...here.keep,
      ...result.words,
      ...list.slice(to),
    ];
    w = put(w);
    if (h !== undefined) h = put(h);
  }
  return undefined;
}
