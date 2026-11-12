/**
 * The assignment grammar the harness rules share (wave 6, T1).
 * ------------------------------------------------------------------------------------------------
 * `harness-switch.ts` (the variables that switch the harness off), `git-exec-strings.ts` (the git variables that
 * carry a command line or name a file git writes) and `env-hazards.ts` (the variables that change what a nested
 * agent's hook loads) all read the same shapes: `NAME=v`, `NAME+=v`, `${NAME:=v}`, a name spelled with quotes,
 * backslashes or a brace group in between (`GIT_TR\ACE=x`, `GIT_TRACE{,}=x`). One reading, so a spelling one rule
 * learns is learned by every rule. Pure.
 */

/** `=`, `+=` and `:=` (the last two only matter to the shell, but `${NAME:=v}` really assigns). */
export const ASSIGN = "[:+]?=";

const MAX_VARIANTS = 64;

/** `a{b,c}d` as `abd` and `acd`: one flat pass per group, bounded. Past the bound the word is kept whole. */
export function braceVariants(word: string): string[] {
  let out = [word];
  for (let round = 0; round < 8 && out.length < MAX_VARIANTS; round++) {
    const next: string[] = [];
    let changed = false;
    for (const w of out) {
      const open = w.indexOf("{");
      const close = open < 0 ? -1 : w.indexOf("}", open);
      const body = close < 0 ? "" : w.slice(open + 1, close);
      if (close < 0 || !body.includes(",") || body.includes("{")) {
        next.push(w);
        continue;
      }
      changed = true;
      for (const alt of body.split(","))
        next.push(`${w.slice(0, open)}${alt}${w.slice(close + 1)}`);
    }
    out = next.slice(0, MAX_VARIANTS);
    if (!changed) break;
  }
  return out;
}

/** A word the way the shell passes it on: backslashes removed, braces expanded. */
export const shellWords = (words: readonly string[]): string[] =>
  words.flatMap((w) => braceVariants(w.replace(/\\(.)/gs, "$1")));

/** The shell builtins whose arguments are `NAME=value` words (`env` is a wrapper the word reader already peels). */
export const VARIABLE_SETTERS: readonly string[] = [
  "export",
  "declare",
  "typeset",
  "readonly",
  "local",
];

/** One variable a word assigns: its name and the text after the operator, as written. */
export interface Assignment {
  readonly name: string;
  readonly value: string;
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables the words assign. The NAME is read the way the shell reads it (backslashes dropped, a brace group
 * expanded: `GIT_TRACE{,}=x` assigns twice); the VALUE is kept as written, because a command line in it is judged
 * as text and a brace or backslash inside it is not the shell's to expand once it is quoted. A word with no
 * assignment in it, or whose name is not a variable name, assigns nothing.
 */
export function assignments(words: readonly string[]): Assignment[] {
  const out: Assignment[] = [];
  for (const word of words) {
    const eq = word.indexOf("=");
    if (eq <= 0) continue;
    const head = word.slice(0, eq).replace(/[:+]$/, "");
    for (const name of shellWords([head])) {
      if (VARIABLE_NAME.test(name)) out.push({ name, value: word.slice(eq + 1) });
    }
  }
  return out;
}
