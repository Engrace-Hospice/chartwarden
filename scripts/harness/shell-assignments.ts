/**
 * The assignment grammar the harness rules share (wave 6, T1; one grammar for real in wave 7, CR5-3).
 * ------------------------------------------------------------------------------------------------
 * `harness-switch.ts` (the variables that switch the harness off), `git-exec-strings.ts` (the git variables that
 * carry a command line or name a file git writes) and `env-hazards.ts` (the variables that change what a nested
 * agent's hook loads) all read the same shapes through `assignments()`: `NAME=v`, `NAME+=v`, `${NAME:=v}` wherever it
 * stands in a word, a name spelled with quotes, backslashes or a brace group in between (`GIT_TR\ACE=x`,
 * `GIT_TRACE{,}=x`, `GIT_TRACE{2..2}=x`). One reading, so a spelling one rule learns is learned by every rule. A name the
 * guard cannot place after expansion (`${X}=v`, `$(…)=v`) is `hasUnplaceableName`: a human decides. Pure but for the
 * brace expander's budget (`work-budget.ts`).
 */
import { expandBraces } from "./work-budget";

/** `=`, `+=` and `:=` (the last two only matter to the shell, but `${NAME:=v}` really assigns). */
export const ASSIGN = "[:+]?=";

/** A word the way the shell passes it on: backslashes removed, braces expanded (`{a,b}` and `{a..b}`, bounded). */
export const shellWords = (words: readonly string[]): string[] =>
  words.flatMap((w) => expandBraces(w.replace(/\\(.)/gs, "$1")));

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
/** `${NAME:=value}` and `${NAME=value}` inside a word: expanding it ASSIGNS NAME (`: ${GIT_TRACE:=/x}`). */
const PARAMETER_ASSIGNMENT = /\$\{([A-Za-z_][A-Za-z0-9_]*):?=([^}]*)\}/g;

/** Does this word hold a `${NAME:=v}` that assigns? (A command that is not an assigning builtin may still carry one.) */
export const hasParameterAssignment = (word: string): boolean => /\$\{[A-Za-z_]\w*:?=/.test(word);

/**
 * The variables the words assign. The NAME is read the way the shell reads it (backslashes dropped, a brace group
 * expanded: `GIT_TRACE{,}=x` assigns twice, `GIT_TRACE{2..2}=x` assigns GIT_TRACE2); the VALUE is kept as written,
 * because a command line in it is judged as text and a brace or backslash inside it is not the shell's to expand once
 * it is quoted. `${NAME:=v}` assigns too, wherever it stands in a word. A word with no assignment in it, or whose name
 * is not a variable name, assigns nothing.
 */
export function assignments(words: readonly string[]): Assignment[] {
  const out: Assignment[] = [];
  for (const word of words) {
    for (const m of word.matchAll(PARAMETER_ASSIGNMENT)) {
      out.push({ name: m[1] as string, value: m[2] as string });
    }
    const eq = word.indexOf("=");
    if (eq <= 0) continue;
    const head = word.slice(0, eq).replace(/[:+]$/, "");
    for (const name of shellWords([head])) {
      if (VARIABLE_NAME.test(name)) out.push({ name, value: word.slice(eq + 1) });
    }
  }
  return out;
}

/**
 * Does one of these assigning words (`export` and kin) have a NAME the guard cannot place: it still holds a brace, a
 * `$` or a backtick once expanded (`export ${X}=v`, an unclosed `{`)? Whatever the name turns out to be at run time, a
 * human decides.
 */
export function hasUnplaceableName(words: readonly string[]): boolean {
  return words.some((word) => {
    const eq = word.indexOf("=");
    if (eq <= 0 || word.startsWith("-")) return false;
    const head = word.slice(0, eq).replace(/[:+]$/, "");
    return shellWords([head]).some((name) => /[${}`]/.test(name));
  });
}
