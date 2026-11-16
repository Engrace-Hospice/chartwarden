/**
 * One reader of a command's own options (wave 10, A2/A5/A8; round-7 R7-ADV-4, R7-ADV-6, R7-CR-2, R7-CR-12).
 * -----------------------------------------------------------------------------------------------------------
 * A wrapper (`sudo`, `timeout`, `nice`, `taskset`, ...) and a package manager are stripped before the command they
 * run is judged, so the guard has to know where the options end. Three readers of three tables disagreed: a short
 * cluster was read as one word (`sudo -upostgres` hid `-u`'s value letter `e`, `-nu postgres` ate the user's name as
 * the command), a long option was a prefix test that read a FLAG as a value (`sudo --login`, a prefix of
 * `--login-class`, ate the command), `timeout` and `taskset` had readers of their own that took no abbreviations.
 * This reader takes a grammar (the tool's real short flags, short value options, long flags and long value options)
 * and reads the way GNU getopt does:
 *
 *   - a long option is an exact name first (a flag that prefixes a value option stays a flag), then any unambiguous
 *     prefix of ONE character or more over the flags AND the value options together; an ambiguous prefix that spans
 *     a flag and a value option cannot be placed;
 *   - a short cluster is read letter by letter and ends at the first letter that takes a value: the rest of the word
 *     is the value, or the next word when nothing is left; a letter with an OPTIONAL argument takes only what is
 *     attached;
 *   - `--` ends the options; the first word that is not an option is where the command starts.
 *
 * Anything the table does not place (an unknown letter, an unknown long option, an ambiguous prefix) is reported as
 * `unplaced`: the guard cannot tell where the inner command starts, so it asks instead of letting a guessed word
 * stand for the command (rule 3 of wave 10: unknown is not allow). A grammar for a tool whose options cannot be listed
 * completely is `lax`: it reads an unknown option as a flag, the older behaviour, and says so in its comment.
 * Pure.
 */

export interface OptionGrammar {
  /** Short option letters that take no value. */
  readonly flags: string;
  /** Short option letters that take a value: the rest of the word, or the next word. */
  readonly values: string;
  /** Short option letters whose value, if any, is only the rest of the word (`xargs -i[REPLACE]`, `sudo -h[HOST]`). */
  readonly optional?: string;
  /** Long options (without `--`) that take no separate value (`--name=V` still carries one). */
  readonly longFlags: readonly string[];
  /** Long options that take a required value: `--name V` or `--name=V`. */
  readonly longValues: readonly string[];
  /** Options spelled as one word with a single dash (`arch -arm64`, `xcrun -sdk X`): exact words, never clusters. */
  readonly wordValues?: readonly string[];
  /** Single-dash words are whole options, not clusters (`arch -x86_64`): unmatched ones are flags. */
  readonly wholeWords?: boolean;
  /** `nice -10`: a dash and digits is a flag. */
  readonly numeric?: boolean;
  /** A lone `-` is a flag (`env - cmd` is `env -i cmd`). */
  readonly loneDash?: boolean;
  /** Read an option the table does not know as a flag instead of reporting it (the table is not complete). */
  readonly lax?: boolean;
  /** The tool takes no abbreviation of a long option (BSD and Go tools): only exact names count. */
  readonly exact?: boolean;
}

export interface ReadOption {
  /** The option's name as the table spells it: the short letter, or the long name without `--`. */
  readonly name: string;
  /** Its value, when the word carried one or the next word was taken. */
  readonly value: string | undefined;
}

export interface OptionsRead {
  /** Index of the first word after the options (and a `--` that ended them). */
  readonly end: number;
  /** Index just after the last option word, before a `--` that ended them. */
  readonly optionsEnd: number;
  /** Every option read, in order; a cluster contributes one entry per letter. */
  readonly options: readonly ReadOption[];
  /** The first word the grammar could not place, when there was one. */
  readonly unplaced?: string;
}

/** How a name that is not spelled exactly resolves: a kind, an ambiguity, or nothing. */
type LongKind =
  | { readonly kind: "flag" | "value"; readonly name: string }
  | "ambiguous"
  | undefined;

/** Resolve the text after `--` (up to any `=`) against the grammar: an exact name, else an unambiguous prefix. */
export function resolveLong(grammar: OptionGrammar, given: string): LongKind {
  if (given === "") return undefined;
  if (grammar.longFlags.includes(given)) return { kind: "flag", name: given };
  if (grammar.longValues.includes(given)) return { kind: "value", name: given };
  if (grammar.exact === true) return undefined;
  const candidates = [
    ...grammar.longFlags
      .filter((n) => n.startsWith(given))
      .map((name) => ({ kind: "flag" as const, name })),
    ...grammar.longValues
      .filter((n) => n.startsWith(given))
      .map((name) => ({ kind: "value" as const, name })),
  ];
  const first = candidates[0];
  if (first === undefined) return undefined;
  return candidates.every((c) => c.kind === first.kind) ? first : "ambiguous";
}

/** Read one long option word at `k`; returns the words it used and the option. */
function readLong(
  grammar: OptionGrammar,
  words: readonly string[],
  k: number,
): { used: number; option: ReadOption; unplaced?: string } {
  const word = words[k] as string;
  const eq = word.indexOf("=");
  const given = word.slice(2, eq < 0 ? undefined : eq);
  const found = resolveLong(grammar, given);
  if (found === undefined || found === "ambiguous") {
    const unplaced = grammar.lax === true && found === undefined ? undefined : word;
    return {
      used: 1,
      option: { name: given, value: eq < 0 ? undefined : word.slice(eq + 1) },
      ...(unplaced === undefined ? {} : { unplaced }),
    };
  }
  if (eq >= 0) return { used: 1, option: { name: found.name, value: word.slice(eq + 1) } };
  if (found.kind === "flag") return { used: 1, option: { name: found.name, value: undefined } };
  const next = words[k + 1];
  return { used: next === undefined ? 1 : 2, option: { name: found.name, value: next } };
}

/** Read one short cluster (`-nu`, `-upostgres`, `-n5`) at `k`. */
function readCluster(
  grammar: OptionGrammar,
  words: readonly string[],
  k: number,
  options: ReadOption[],
): { used: number; unplaced?: string } {
  const word = words[k] as string;
  let unplaced: string | undefined;
  for (let p = 1; p < word.length; p++) {
    const letter = word[p] as string;
    if (grammar.values.includes(letter)) {
      const attached = word.slice(p + 1).replace(/^=/, "");
      if (p + 1 < word.length) {
        options.push({ name: letter, value: attached });
        return { used: 1 };
      }
      const next = words[k + 1];
      options.push({ name: letter, value: next });
      return { used: next === undefined ? 1 : 2 };
    }
    if (grammar.optional?.includes(letter) === true) {
      const attached = p + 1 < word.length ? word.slice(p + 1) : undefined;
      options.push({ name: letter, value: attached });
      return { used: 1 };
    }
    if (grammar.flags.includes(letter)) options.push({ name: letter, value: undefined });
    else if (grammar.lax === true) options.push({ name: letter, value: undefined });
    else unplaced ??= word;
  }
  return { used: 1, ...(unplaced === undefined ? {} : { unplaced }) };
}

/** Read one single-dash whole-word option (`arch -arm64`, `-arch x86_64`). */
function readWholeWord(
  grammar: OptionGrammar,
  words: readonly string[],
  k: number,
): { used: number; option: ReadOption } {
  const word = words[k] as string;
  if (grammar.wordValues?.includes(word) === true) {
    const next = words[k + 1];
    return { used: next === undefined ? 1 : 2, option: { name: word, value: next } };
  }
  return { used: 1, option: { name: word, value: undefined } };
}

/** The options at `words[from..]`, per the grammar; see the header for what ends them. */
export function readOptions(
  grammar: OptionGrammar,
  words: readonly string[],
  from: number,
): OptionsRead {
  const options: ReadOption[] = [];
  let unplaced: string | undefined;
  let k = from;
  let optionsEnd = -1;
  while (k < words.length) {
    const word = words[k] as string;
    if (word === "--") {
      optionsEnd = k++;
      break;
    }
    if (!word.startsWith("-")) break;
    if (word === "-") {
      if (grammar.loneDash !== true) break;
      k++;
      continue;
    }
    if (word.startsWith("--")) {
      const read = readLong(grammar, words, k);
      options.push(read.option);
      unplaced ??= read.unplaced;
      k += read.used;
    } else if (grammar.numeric === true && /^-\d+$/.test(word)) {
      k++;
    } else if (grammar.wholeWords === true) {
      const read = readWholeWord(grammar, words, k);
      options.push(read.option);
      k += read.used;
    } else {
      const read = readCluster(grammar, words, k, options);
      unplaced ??= read.unplaced;
      k += read.used;
    }
  }
  return {
    end: k,
    optionsEnd: optionsEnd < 0 ? k : optionsEnd,
    options,
    ...(unplaced === undefined ? {} : { unplaced }),
  };
}
