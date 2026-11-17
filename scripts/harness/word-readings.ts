/**
 * The other readings of a simple command whose words the shell builds at run time (wave 13 part A, A2 and A3; R10-ADV).
 * ------------------------------------------------------------------------------------------------------------------
 * The rules read a command's words as typed, so a word the shell assembles was never the word a rule looks for: `--no-verify${X}`,
 * `--no-ver\ify`, `git p${X}ush --force` (an empty expansion, a backslash or a `$(true)` spliced into an option or a subcommand), and
 * `A=--no-verify; git commit $A`, `set -- --no-verify; git commit "$@"`, `args=(--no-verify); git commit "${args[@]}"` (a variable, the
 * positional parameters or an array that holds the option) all ran the real command with no rule firing. Each of them is the same command
 * once the words are what the shell makes of them. This module writes that command out as text, so the classifier judges it like any other:
 *
 *  - a variable, the positional parameters (`set --`) or an array that an EARLIER statement of the command line binds to a plain literal
 *    is replaced by each value it may hold (`exact` readings: the command says what runs);
 *  - a backslash before an ordinary character is removed (`exact`);
 *  - an expansion no statement places (`${X}`, `$(true)`, a backtick pair) is removed where it is SPLICED into a word with other text, or where
 *    it is the program or the subcommand word (`${X}psql`, `git ${X}push`): the word is read as it would be if the expansion were empty (not
 *    `exact`: the expansion may hold something else at run time, so the verdict of that reading is capped at ask).
 *
 * It is deliberately NARROW: an unplaced expansion that stands alone as an argument (`git checkout $branch`, `git commit -m "$msg"`) is left
 * as typed, and a word that only HOLDS an expansion beside text (`git log --since=$d`) reads as a command that every rule allows anyway.
 * A word that is a redirection is left alone. A value is used only when it is a plain literal (letters, digits, `_ @ % + = : , . / ~ -` and
 * blanks), so a reading never changes the structure of the line.
 * Pure.
 */
import { words } from "./command-words";

/** What an earlier statement of the command line bound: literal values by name (every value, in order), arrays, and the positional parameters. */
export interface Bindings {
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly arrays: ReadonlyMap<string, readonly string[]>;
  /** The words of the last `set --`; `null` while none was set. */
  readonly positional: readonly string[] | null;
}

export const NO_BINDINGS: Bindings = { values: new Map(), arrays: new Map(), positional: null };

/** A value the guard writes into a command: nothing the shell would expand, split into other commands or glob. */
const SAFE_VALUE = /^[\w@%+=:,./~ -]*$/;
/** An ordinary character: `\x` is `x` when it is one of these (a backslash before anything else may quote it from the shell). */
const PLAIN_ESCAPED = /^[A-Za-z0-9_./:=+,@%-]$/;
/** At most this many readings of one command are judged; a command with more asks. */
export const MAX_READINGS = 8;
/** At most this many words are read; a longer command is not read at all (it is no everyday command line). */
const MAX_WORDS = 400;

const ARRAY_ASSIGNMENT =
  /^\s*(?:(?:declare|local|typeset|readonly|export)\s+(?:-\w+\s+)*)?([A-Za-z_]\w*)=\(([^()]*)\)\s*$/;

/** The bindings after one more statement: its `NAME=value` words (`variableStatementWords`), an array assignment or a `set --`. */
export function bindAfter(
  before: Bindings,
  segmentText: string,
  statementWords: readonly string[],
): Bindings {
  const values = new Map(before.values);
  for (const word of statementWords) {
    const eq = word.indexOf("=");
    if (eq <= 0) continue;
    const name = word.slice(0, eq).replace(/\+$/, "");
    const value = word.slice(eq + 1);
    if (SAFE_VALUE.test(value)) values.set(name, [...(values.get(name) ?? []), value]);
  }
  const array = ARRAY_ASSIGNMENT.exec(segmentText);
  const arrays = new Map(before.arrays);
  if (array !== null) {
    const elements = words(array[2] ?? "");
    arrays.set(
      array[1] as string,
      elements.every((element) => SAFE_VALUE.test(element)) ? elements : [],
    );
  }
  const set = /^\s*set\s+--(?:\s+(.*))?$/s.exec(segmentText);
  const given = set === null ? null : words(set[1] ?? "");
  const positional =
    given === null ? before.positional : given.every((w) => SAFE_VALUE.test(w)) ? given : null;
  return { values, arrays, positional };
}

type Piece =
  | { readonly kind: "lit"; readonly src: string }
  | { readonly kind: "esc"; readonly src: string; readonly value: string }
  | {
      readonly kind: "exp";
      readonly src: string;
      /** A name, a positional (`1`, `@`, `*`) or `""` for an expansion that is no plain reference (`$(…)`, `${X:-y}`). */
      readonly name: string;
      readonly array: boolean;
    };

type Item =
  | { readonly kind: "space"; readonly src: string }
  | { readonly kind: "word"; readonly pieces: Piece[] };

/** The index just after the construct that opens at `from` (`$(`, `${`), or -1 when the text ends first. */
function closeOf(text: string, from: number, open: string, close: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "\\") i++;
    else if (ch === "'" && open === "(") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return i + 1;
  }
  return -1;
}

function closeOfBacktick(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "`") return i + 1;
  }
  return -1;
}

/** What `$…` at `at` is: the piece and the index after it (a lone `$` is text). */
function expansionAt(text: string, at: number): { piece: Piece; end: number } {
  const next = text[at + 1] ?? "";
  const lit = (end: number): { piece: Piece; end: number } => ({
    piece: { kind: "lit", src: text.slice(at, end) },
    end,
  });
  if (next === "(" || next === "{") {
    const end = next === "(" ? closeOf(text, at + 1, "(", ")") : closeOf(text, at + 1, "{", "}");
    if (end < 0) return lit(text.length);
    const src = text.slice(at, end);
    const braced = /^\$\{([A-Za-z_]\w*)(?:\[([@*])\])?\}$/.exec(src);
    return {
      piece: { kind: "exp", src, name: braced?.[1] ?? "", array: braced?.[2] !== undefined },
      end,
    };
  }
  const named = /^[A-Za-z_]\w*/.exec(text.slice(at + 1));
  if (named !== null) {
    const src = `$${named[0]}`;
    return { piece: { kind: "exp", src, name: named[0], array: false }, end: at + src.length };
  }
  if (/^[0-9@*]$/.test(next))
    return { piece: { kind: "exp", src: `$${next}`, name: next, array: false }, end: at + 2 };
  if (/^[?$#!-]$/.test(next))
    return { piece: { kind: "exp", src: `$${next}`, name: "", array: false }, end: at + 2 };
  return lit(at + 1);
}

const DOUBLE_QUOTE_ESCAPES = '"\\$`';

/** The command split into words and the blanks between them; a word is literal text, escapes and expansions, the source text kept for the rest. */
function tokenize(text: string): Item[] | null {
  const items: Item[] = [];
  let pieces: Piece[] | null = null;
  let literal = "";
  let inDouble = false;
  let count = 0;
  const flushLiteral = (): void => {
    if (literal !== "") (pieces ??= []).push({ kind: "lit", src: literal });
    literal = "";
  };
  const endWord = (): boolean => {
    flushLiteral();
    if (pieces !== null) items.push({ kind: "word", pieces });
    pieces = null;
    return ++count <= MAX_WORDS;
  };
  const push = (piece: Piece): void => {
    flushLiteral();
    (pieces ??= []).push(piece);
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (!inDouble && /\s/.test(ch)) {
      if (!endWord()) return null;
      const last = items.at(-1);
      if (last?.kind === "space") items[items.length - 1] = { kind: "space", src: last.src + ch };
      else items.push({ kind: "space", src: ch });
    } else if (ch === "'" && !inDouble) {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return null;
      literal += text.slice(i, end + 1);
      i = end;
    } else if (ch === '"') {
      inDouble = !inDouble;
      literal += ch;
    } else if (ch === "\\") {
      const next = text[i + 1];
      if (next === undefined) return null;
      if (inDouble && !DOUBLE_QUOTE_ESCAPES.includes(next)) literal += ch;
      else {
        if (!inDouble && PLAIN_ESCAPED.test(next))
          push({ kind: "esc", src: `\\${next}`, value: next });
        else literal += `\\${next}`;
        i++;
      }
    } else if (ch === "`") {
      const end = closeOfBacktick(text, i);
      if (end < 0) return null;
      push({ kind: "exp", src: text.slice(i, end), name: "", array: false });
      i = end - 1;
    } else if (ch === "$" && text[i + 1] === "'") {
      const end = text.indexOf("'", i + 2);
      if (end < 0) return null;
      literal += text.slice(i, end + 1);
      i = end;
    } else if (ch === "$") {
      const { piece, end } = expansionAt(text, i);
      if (piece.kind === "lit") literal += piece.src;
      else push(piece);
      i = end - 1;
    } else literal += ch;
  }
  return endWord() ? items : null;
}

const QUOTE_ONLY = /^["']*$/;
const REDIRECTION_WORD = /^(?:[0-9]*[<>]|&>)/;

type Expansion = Piece & { readonly kind: "exp" };

/** The values `piece` may hold according to the bindings, or null when no statement places it. */
function valuesOf(piece: Expansion, b: Bindings): readonly string[] | null {
  const { name } = piece;
  if (name === "") return null;
  if (/^[0-9]$/.test(name))
    return b.positional === null ? null : [b.positional[Number(name) - 1] ?? ""];
  if (name === "@" || name === "*") return b.positional === null ? null : [b.positional.join(" ")];
  if (piece.array || b.arrays.has(name)) {
    const elements = b.arrays.get(name);
    return elements === undefined ? null : [elements.join(" ")];
  }
  const known = b.values.get(name);
  return known === undefined ? null : [...new Set(known)];
}

export interface Reading {
  readonly text: string;
  /** Every change is something the command says (a known value, a backslash); a removed expansion is a guess. */
  readonly exact: boolean;
}

export interface Readings {
  readonly list: readonly Reading[];
  /** More readings than the cap: the rest were not judged. */
  readonly overCap: boolean;
}

const NONE: Readings = { list: [], overCap: false };

/** Each word's place among the words of the command, leading `NAME=value` words not counted (the program is place 0). */
function wordPlaces(items: readonly Item[]): Map<Item, number> {
  const places = new Map<Item, number>();
  let n = 0;
  for (const item of items) {
    if (item.kind !== "word") continue;
    const first = item.pieces[0];
    if (first?.kind === "lit" && /^[A-Za-z_]\w*\+?=/.test(first.src) && n === 0) continue;
    places.set(item, n++);
  }
  return places;
}

function build(
  items: readonly Item[],
  places: ReadonlyMap<Item, number>,
  valueOf: (src: string) => string | null,
): Reading {
  let exact = true;
  let out = "";
  for (const item of items) {
    if (item.kind === "space") {
      out += item.src;
      continue;
    }
    const first = item.pieces[0];
    const redirection = first?.kind === "lit" && REDIRECTION_WORD.test(first.src);
    const content = item.pieces.filter((p) => !(p.kind === "lit" && QUOTE_ONLY.test(p.src)));
    const place = places.get(item);
    const removable = content.length > 1 || (place !== undefined && place < 2);
    for (const piece of item.pieces) {
      if (piece.kind === "lit" || redirection) out += piece.src;
      else if (piece.kind === "esc") out += piece.value;
      else {
        const value = valueOf(piece.src);
        if (value !== null) out += value;
        else if (removable) exact = false;
        else out += piece.src;
      }
    }
  }
  return { text: out, exact };
}

/** The other readings of `text` (one simple command), each different from `text`; none for an ordinary command. */
export function readingsOf(text: string, b: Bindings): Readings {
  if (!/[$`\\]/.test(text)) return NONE;
  const items = tokenize(text);
  if (items === null) return NONE;
  const places = wordPlaces(items);
  // The references whose values multiply the readings, in the order they first appear, with the values each may hold.
  const placed = new Map<string, readonly string[]>();
  for (const item of items) {
    if (item.kind !== "word") continue;
    for (const piece of item.pieces) {
      if (piece.kind !== "exp" || placed.has(piece.src)) continue;
      const values = valuesOf(piece, b);
      if (values !== null) placed.set(piece.src, values);
    }
  }
  let picks: Array<Map<string, string>> = [new Map()];
  let overCap = false;
  for (const [src, values] of placed) {
    const next = picks.flatMap((pick) => values.map((value) => new Map(pick).set(src, value)));
    overCap ||= next.length > MAX_READINGS;
    picks = next.slice(0, MAX_READINGS);
  }
  const seen = new Set<string>([text]);
  const list: Reading[] = [];
  for (const pick of picks) {
    const reading = build(items, places, (src) => pick.get(src) ?? null);
    if (seen.has(reading.text)) continue;
    seen.add(reading.text);
    list.push(reading);
  }
  return { list, overCap };
}
