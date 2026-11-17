/**
 * `env -S STRING`: the words env itself makes of its string (wave 11 part C, C1; round-8 R8-ADV-1, a deny-to-allow regression of wave 10).
 * -----------------------------------------------------------------------------------------------------------------------------------
 * Wave 10 peeled `env -S` and read the string with the SHELL's word reader, which is not env's own split grammar: `env -S 'cat\_.env'`
 * (a `\_` is a separator), `env -S 'cat .env\c'` (`\c` ends the string), `${NAME}` expansion, and escapes the shell reads differently
 * hid the command from every rule. This is the grammar of the env installed here (macOS env and GNU coreutils agree; each rule below was
 * checked against `env -S 'echo ...'`, the `envprobe` cases of `harness-env-split-wave11.test.ts`):
 *   - outside quotes: blanks (space, tab, newline, `\v`, `\f`, `\r`) separate words; `#` at the START of a word starts a comment that
 *     runs to the end of the string (`a#b` is one word); `\_` separates words (a space in a word inside double quotes); `\c` ends the string,
 *     the word before it stays; `\t \n \r \f \v` are those control characters; `\\ \" \' \$ \#` are the character itself; a backslash
 *     before anything else, or at the end, is an error (env exits 1 and runs nothing);
 *   - `'…'`: no expansion; only `\\` and `\'` are escapes, every other backslash stays;
 *   - `"…"`: `${NAME}` expands, `\"` `\\` `\$` `\#` `\t…` `\_` are escapes, `\c` is an error, any other escape is an error;
 *   - `${NAME}` (a name of letters, digits and `_`) expands from env's environment and is empty when unset; a bare `$NAME`, `${}`, an
 *     unterminated `${` are errors; a missing closing quote is an error.
 * Anything that is an error to env, and a `${NAME}` the caller cannot place, is returned as `unplaced`: the guard asks instead of
 * letting a guessed reading stand for the command (rule 2 of wave 11: unknown is not allow). Pure.
 */

export interface EnvSplit {
  /** The words env hands its command, in order (assignments included, as env reads them). */
  readonly words: readonly string[];
  /** Why the string could not be read, when it could not: env would reject it, or a variable is unplaced. */
  readonly unplaced?: string;
}

/** The value of a variable env would see: undefined when the caller cannot place it. */
export type EnvLookup = (name: string) => string | undefined;

const BLANK = /[ \t\n\v\f\r]/;
const CONTROL: Readonly<Record<string, string>> = {
  t: "\t",
  n: "\n",
  r: "\r",
  f: "\f",
  v: "\v",
};
const PLAIN_ESCAPES = new Set(["\\", '"', "'", "$", "#"]);

class Unplaced extends Error {}

const fail = (why: string): never => {
  throw new Unplaced(why);
};

/** What a backslash escape does to the word being read. */
type Escape =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "separator" }
  | { readonly kind: "stop" };

/** The escape `\next`, read in or out of double quotes; an escape env rejects fails. */
function escapeOf(next: string | undefined, inDouble: boolean): Escape {
  if (next === undefined) return fail("a backslash at the end of the string");
  if (next === "_") return inDouble ? { kind: "text", text: " " } : { kind: "separator" };
  if (next === "c") return inDouble ? fail("`\\c` inside quotes") : { kind: "stop" };
  const control = CONTROL[next];
  if (control !== undefined) return { kind: "text", text: control };
  return PLAIN_ESCAPES.has(next) ? { kind: "text", text: next } : fail(`\`\\${next}\``);
}

/** The `${NAME}` that starts at `at` (a `$`): its value and the index of its closing brace. */
function expansionAt(
  text: string,
  at: number,
  lookup: EnvLookup,
): { value: string; close: number } {
  const close = text[at + 1] === "{" ? text.indexOf("}", at + 2) : -1;
  const name = close < 0 ? "" : text.slice(at + 2, close);
  if (close < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail("a `$` that is not `${NAME}`");
  const value = lookup(name);
  return value === undefined
    ? fail(`\`\${${name}}\`, a variable the guard cannot place`)
    : { value, close };
}

/** One scan of the string; a rejected construct is thrown as an Unplaced and caught once. */
function scan(text: string, lookup: EnvLookup): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  const endWord = (): void => {
    if (inWord) words.push(current);
    current = "";
    inWord = false;
  };
  const add = (more: string): void => {
    current += more;
    inWord = true;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else if (ch === "\\" && (text[i + 1] === "\\" || text[i + 1] === "'")) current += text[++i];
      else current += ch;
    } else if (ch === "\\") {
      const found = escapeOf(text[++i], quote === '"');
      if (found.kind === "text") add(found.text);
      else {
        endWord();
        if (found.kind === "stop") return words;
      }
    } else if (ch === "$") {
      const expansion = expansionAt(text, i, lookup);
      add(expansion.value);
      i = expansion.close;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (BLANK.test(ch)) endWord();
    else if (ch === "#" && !inWord) return words;
    else add(ch);
  }
  if (quote !== null) fail("a quote that is never closed");
  endWord();
  return words;
}

/** The words `env -S text` runs, or why they cannot be told. `lookup` places `${NAME}` (the assignments in front of env). */
export function splitEnvString(text: string, lookup: EnvLookup = () => undefined): EnvSplit {
  try {
    return { words: scan(text, lookup) };
  } catch (error) {
    if (!(error instanceof Unplaced)) throw error;
    return { words: [], unplaced: `env -S ${error.message}` };
  }
}
