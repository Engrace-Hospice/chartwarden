/**
 * Strip one wrapper from the front of a command (wave 10, A2/A5: R7-ADV-4, R7-ADV-6, R7-CR-2, R7-CR-15): which of its words are
 * options, which are operands, where the command starts, and what its options and operands name. The classifier calls this
 * wherever it finds a program word that is a wrapper (`WRAPPER_SPECS`), so `sudo`, `nice`, `timeout`, `taskset` and the rest
 * have ONE reader of their options (`option-grammar.ts`) and `timeout` is no longer a special case of its own. Pure.
 */
import type { EnvSplit } from "./env-split";
import { type ReadOption, readOptions } from "./option-grammar";
import { type WrapperFiles, wrapperFiles } from "./wrapper-options";
import { WRAPPER_SPECS, type WrapperSpec } from "./wrapper-specs";

export interface WrapperPeel {
  /** The wrapper's name as the table spells it. */
  readonly wrapper: string;
  /** Index of the command it runs; for a wrapper that `stays`, the index of its first own word. */
  readonly next: number;
  /** The wrapper runs no command word (`sudo -e FILE`, `flock -c STRING`): it stays the program. */
  readonly stays: boolean;
  /** The directory it runs the command in, when an option names one. */
  readonly chdir?: string;
  /** Every option it read, with its value. */
  readonly options: readonly ReadOption[];
  /** The files its options and operands read and write. */
  readonly files: WrapperFiles;
  /** Words that run before `next` and stand for the command (`env -S 'cmd arg'`): spliced in at `next`. */
  readonly insert: readonly string[];
  /** The first word of its own the table could not place: the guard cannot tell where the command starts. */
  readonly unplaced?: string;
}

const named = (
  options: readonly ReadOption[],
  names: readonly string[] | undefined,
): ReadOption[] => options.filter((option) => names?.includes(option.name) === true);

/** The operands the wrapper takes before its command, read after its options. */
function takeOperands(
  spec: WrapperSpec,
  words: readonly string[],
  at: number,
  options: readonly ReadOption[],
): readonly string[] {
  if (spec.operands === undefined || named(options, spec.suppliedBy).length > 0) return [];
  return words.slice(at, at + spec.operands);
}

/**
 * The values of the options that split a string (`env -S STRING`), as the wrapper is HANDED them: read from `handed` (the same words
 * with a backslash read once, the way the shell hands them over) when there is one. `null` handed (the indices were lost to a rewrite)
 * reads as nothing, which the caller turns into a question.
 */
function splitTexts(
  spec: WrapperSpec,
  words: readonly string[],
  at: number,
  primary: readonly ReadOption[],
  handed: readonly string[] | null | undefined,
): readonly string[] | null {
  const values = (options: readonly ReadOption[]): string[] =>
    named(options, spec.splits).map((option) => option.value ?? "");
  if (handed === undefined) return values(primary);
  if (handed === null) return null;
  const again = values(readOptions(spec.grammar, handed, at + 1).options);
  return again.length === values(primary).length ? again : null;
}

/**
 * The wrapper at `words[at]`, stripped; null when the word is no wrapper or the wrapper has nothing after it (`sudo` alone is
 * the program `sudo`). `split` reads a string the way the wrapper itself does (`env -S`); `handed` is `words` as the programs are
 * handed them (a backslash read once), same indices, undefined when it is the same text.
 */
export function peelWrapper(
  wrapper: string,
  words: readonly string[],
  at: number,
  split: (text: string) => EnvSplit,
  handed?: readonly string[] | null,
): WrapperPeel | null {
  const spec = WRAPPER_SPECS.get(wrapper);
  if (spec === undefined || at + 1 >= words.length) return null;
  const read = readOptions(spec.grammar, words, at + 1);
  let options = read.options;
  let unplaced = read.unplaced;
  let next = read.end;
  const operands = takeOperands(spec, words, next, options);
  next += operands.length;
  if (spec.onlyWith !== undefined && named(options, spec.onlyWith).length === 0) return null;
  let stays = named(options, spec.stays).length > 0;
  // `flock FILE -c STRING`, `runuser USER -c STRING`: options may follow the operands once more.
  if (!stays && spec.optionsAfterOperands === true && operands.length > 0) {
    const more = readOptions(spec.grammar, words, next);
    options = [...options, ...more.options];
    unplaced ??= more.unplaced;
    stays = named(more.options, spec.stays).length > 0;
    if (!stays) next = more.end;
  }
  const dir = named(options, spec.chdir).at(-1);
  const insert: string[] = [];
  if (named(options, spec.splits).length > 0) {
    const texts = splitTexts(spec, words, at, options, handed);
    if (texts === null) unplaced ??= `${wrapper} -S string`;
    for (const result of (texts ?? []).map(split)) {
      insert.push(...result.words);
      unplaced ??= result.unplaced;
    }
  }
  return {
    wrapper,
    next: stays ? at : next,
    stays,
    ...(dir === undefined ? {} : { chdir: dir.value ?? "" }),
    options,
    files: wrapperFiles(wrapper, words.slice(at + 1, read.optionsEnd), operands),
    insert,
    ...(unplaced === undefined ? {} : { unplaced }),
  };
}
