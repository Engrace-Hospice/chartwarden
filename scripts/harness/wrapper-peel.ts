/**
 * Strip one wrapper from the front of a command (wave 10, A2/A5: R7-ADV-4, R7-ADV-6, R7-CR-2, R7-CR-15): which of its words are
 * options, which are operands, where the command starts, and what its options and operands name. The classifier calls this
 * wherever it finds a program word that is a wrapper (`WRAPPER_SPECS`), so `sudo`, `nice`, `timeout`, `taskset` and the rest
 * have ONE reader of their options (`option-grammar.ts`) and `timeout` is no longer a special case of its own. Pure.
 */
import type { EnvSplit } from "./env-split";
import { type OptionsRead, type ReadOption, readOptions } from "./option-grammar";
import { expandSplits } from "./split-string-expand";
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
  /** The words from `next` on are ONE command line for a shell (`sudo -s 'CMD'`): the classifier hands them to `sh -c`. */
  readonly shellLine: boolean;
  /**
   * The words with every `env -S STRING` replaced by the words of the string (E1-2): `next` indexes these, and the caller continues with them
   * (and with `handed`, the same in the reading the programs are handed). Absent when the wrapper splits no string.
   */
  readonly rewritten?: {
    readonly words: readonly string[];
    readonly handed: readonly string[] | null | undefined;
  };
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
 * What a wrapper's own script options and `--` mean (E1-6): `leaks … -- CMD` and `lldb -- PROG` run no command without a `--` (`read.optionsEnd` is where the
 * options stopped, `read.end` is after a `--`), and `expect -c`, `lldb -o`, `zx -e` take a script of the tool's own that the guard cannot read: it asks.
 */
function ownScript(
  wrapper: string,
  spec: WrapperSpec,
  read: OptionsRead,
  options: readonly ReadOption[],
): { readonly runsNothing: boolean; readonly question?: string } {
  const asked = named(options, spec.asksWith)[0];
  if (asked !== undefined) {
    return {
      runsNothing: false,
      question: `${wrapper} ${asked.name.length === 1 ? "-" : "--"}${asked.name} SCRIPT`,
    };
  }
  return { runsNothing: spec.dashDash === true && read.optionsEnd === read.end };
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
  // `env -S '-i CMD'`: the words of the string stand where the option was, and env reads its options over them (E1-2)
  const expanded =
    spec.splits === undefined ? undefined : expandSplits(spec, words, at, split, handed);
  const all = expanded?.words ?? words;
  const read = readOptions(spec.grammar, all, at + 1);
  let options = read.options;
  let unplaced = read.unplaced ?? expanded?.unplaced;
  let next = read.end;
  const operands = takeOperands(spec, all, next, options);
  next += operands.length;
  if (spec.onlyWith !== undefined && named(options, spec.onlyWith).length === 0) return null;
  const own = ownScript(wrapper, spec, read, options);
  if (own.runsNothing) return null;
  unplaced ??= own.question;
  let stays = named(options, spec.stays).length > 0;
  // `flock FILE -c STRING`, `runuser USER -c STRING`: options may follow the operands once more.
  if (!stays && spec.optionsAfterOperands === true && operands.length > 0) {
    const more = readOptions(spec.grammar, all, next);
    options = [...options, ...more.options];
    unplaced ??= more.unplaced;
    stays = named(more.options, spec.stays).length > 0;
    if (!stays) next = more.end;
  }
  const dir = named(options, spec.chdir).at(-1);
  return {
    wrapper,
    next: stays ? at : next,
    stays,
    ...(dir === undefined ? {} : { chdir: dir.value ?? "" }),
    options,
    shellLine: !stays && named(options, spec.shellLine).length > 0 && next < all.length,
    files: wrapperFiles(wrapper, all.slice(at + 1, read.optionsEnd), operands),
    ...(expanded === undefined
      ? {}
      : { rewritten: { words: expanded.words, handed: expanded.handed } }),
    ...(unplaced === undefined ? {} : { unplaced }),
  };
}
