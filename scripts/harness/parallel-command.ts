/**
 * GNU parallel's command and its data (wave 10, A6; round-7 R7-ADV-10, R7-ADV-11, R7-CR-12). `parallel cp {} .claude/settings.json
 * ::: /tmp/x` runs `cp /tmp/x .claude/settings.json`: the words before `:::` are the command, the words after it are the data
 * it is run on, and `{}` (or the replacement string the options name) stands for each datum, or the datum is appended when none
 * does. Before this module the data were arguments of the command (`cp` saw `/tmp/x` as its destination), the common quoted form
 * `parallel 'cp {} CLAUDE.md' ::: x` was never judged as a command line, and `parallel ::: 'rm x'` (the data ARE the commands)
 * was not read at all.
 *
 * `parallelExtras` cuts the data off the command and returns the command lines to judge in addition: the command with every
 * datum put where parallel puts it (one line per datum, capped), a quoted command word judged as the command line it is, the
 * data themselves when there is no command, and the files `::::` reads (judged like input redirects). Pure.
 */
import type { ReadOption } from "./option-grammar";
import { shellQuote } from "./wrappers";

/** Data separators: `:::` words, `::::` files, and the `+` forms that link the groups instead of crossing them. */
const SEPARATOR = /^::::?\+?$/;
const FILE_SEPARATOR = /^::::\+?$/;
/** `{}`, `{.}`, `{/}`, `{//}`, `{/.}`, `{#}`, `{%}`, `{1}`: the replacement strings of parallel. */
const DEFAULT_REPLACEMENT = /\{(?:\.|\/|\/\/|\/\.|#|%|\d+)?\}/g;
/** Data judged one by one; the rest are judged together, appended once. */
const MAX_DATA_LINES = 64;

export interface ParallelExtras {
  /** The words of the command, cut off before the first data separator. */
  readonly words: string[];
  /** Command lines to judge in addition to the command itself. */
  readonly lines: string[];
  /** Files `::::` reads. */
  readonly reads: string[];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The replacement strings in force: the defaults, and the ones `-I S`, `--replace S` and `--rpl 'S …'` name. */
function replacementPattern(declared: readonly string[]): RegExp {
  const custom = declared.filter((tag) => tag !== "").map(escapeRegExp);
  return custom.length === 0
    ? DEFAULT_REPLACEMENT
    : new RegExp(`${DEFAULT_REPLACEMENT.source}|${custom.join("|")}`, "g");
}

/** The replacement strings the options declare: `-I S`, `-iS`, `--replace S`, and the tag of `--rpl 'TAG perl'`. */
export function replacementTags(options: readonly ReadOption[]): string[] {
  return options.flatMap((option) => {
    if (option.name === "rpl") return [(option.value ?? "").split(/\s+/)[0] ?? ""];
    return ["I", "i", "replace"].includes(option.name) ? [option.value ?? ""] : [];
  });
}

/** The command line for the words `words` (a first word that holds whitespace is itself a command line). */
function render(words: readonly string[], isLine: boolean): string {
  if (!isLine) return words.map(shellQuote).join(" ");
  const [first, ...rest] = words;
  return [first, ...rest.map(shellQuote)].join(" ");
}

/**
 * The command of a `parallel` whose own options have been read, `words[next..]`: the command words, the data after the
 * separators, and the lines to judge. `declared` are the replacement strings the options name.
 */
export function parallelExtras(
  words: readonly string[],
  next: number,
  declared: readonly string[],
): ParallelExtras {
  const cut = words.findIndex((word, index) => index >= next && SEPARATOR.test(word));
  const command = words.slice(next, cut < 0 ? undefined : cut);
  const tail = cut < 0 ? [] : words.slice(cut);
  const data: string[] = [];
  const reads: string[] = [];
  let files = false;
  for (const word of tail) {
    if (SEPARATOR.test(word)) files = FILE_SEPARATOR.test(word);
    else (files ? reads : data).push(word);
  }
  const kept = [...words.slice(0, next), ...command];
  if (command.length === 0) return { words: kept, lines: data, reads };
  const isLine = /\s/.test(command[0] as string);
  const pattern = replacementPattern(declared);
  const uses = command.some((word) => word.replace(pattern, "") !== word);
  const place = (datum: string): string => {
    const subs = command.map((word) => word.replace(pattern, () => datum));
    return render(uses ? subs : [...command, datum], isLine);
  };
  const lines = data.slice(0, MAX_DATA_LINES).map(place);
  if (data.length > MAX_DATA_LINES) lines.push(place(data.slice(MAX_DATA_LINES).join(" ")));
  // No data (`parallel 'cp {} x' < list`): a command that is one string is still a command line.
  if (data.length === 0 && isLine) lines.push(render(command, true));
  return { words: kept, lines, reads };
}
