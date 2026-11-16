/**
 * The shell variables a database client may read its target from (wave 10, B6; round-7 R7-ADV-8, R7-ADV-17, R7-CR-7).
 * ------------------------------------------------------------------------------------------------
 * Wave 9 tracked `export PGHOST=H; psql` through the one literal a command line assigns to a name, and dropped a name the
 * command line rebinds: `export PGHOST=localhost; export PGHOST=H; psql` then named no host at all, and an assignment
 * inside `bash -c '…'` or `eval '…'` was never seen (the map was built once, from the outer text). A name the guard cannot
 * place is no evidence of a local database. This module keeps EVERY value a variable statement of a text assigns (the
 * statements of the text being judged, and of the texts around it), so a client reads each of them, and a `$NAME` word in
 * a target position is expanded to each of them; a word that still holds `$` or a backtick afterwards cannot be placed.
 * Only `export`-style statements and bare assignments count (`PGHOST=H true; psql` sets the variable for `true` alone).
 * Pure.
 */
import { assignments, hasParameterAssignment } from "./shell-assignments";

/** One simple command, as far as this module needs it: the program, its arguments and its leading `NAME=value` words. */
export interface StatementPart {
  readonly prog: string;
  readonly args: readonly string[];
  readonly assigns: readonly string[];
}

const SETTERS = /^(?:export|declare|typeset|readonly|local)$/;
/** At most this many `NAME=value` words are kept for one text: a longer list is judged by its first words. */
const MAX_STATEMENT_WORDS = 256;

/** The `NAME=value` words a command text's variable statements assign, every one of them, a rebound name included. */
export function variableStatementWords(parts: readonly StatementPart[]): string[] {
  const words: string[] = [];
  for (const part of parts) {
    if (SETTERS.test(part.prog)) words.push(...part.assigns, ...part.args);
    else if (part.prog === "") words.push(...part.assigns);
    else words.push(...part.args.filter(hasParameterAssignment));
    if (words.length >= MAX_STATEMENT_WORDS) break;
  }
  return assignments(words.slice(0, MAX_STATEMENT_WORDS)).map(
    ({ name, value }) => `${name}=${value}`,
  );
}

/** Every value the `NAME=value` words give each name, in order. */
export function valuesByName(words: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  for (const word of words) {
    const eq = word.indexOf("=");
    if (eq <= 0) continue;
    const name = word.slice(0, eq).replace(/\+$/, "");
    out.set(name, [...(out.get(name) ?? []), word.slice(eq + 1)]);
  }
  return out;
}

const VARIABLE_REFERENCE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g;
/** A word the shell would still expand at run time. */
export const HAS_EXPANSION = /[$`]/;
/** At most this many readings of one word (each variable's values multiply): more is read as unplaceable. */
const MAX_READINGS = 8;

export interface Expanded {
  /** The readings of the word, each variable replaced by one of its values (the word itself when it names none). */
  readonly texts: readonly string[];
  /** Some reading still holds a variable or a substitution the guard cannot place. */
  readonly unplaceable: boolean;
}

/** `word` with each `$NAME` / `${NAME}` replaced by every value a statement assigns it; the rest stays as written. */
export function expandVariables(
  word: string,
  values: ReadonlyMap<string, readonly string[]>,
): Expanded {
  if (!HAS_EXPANSION.test(word)) return { texts: [word], unplaceable: false };
  let texts: string[] = [word];
  for (const name of new Set([...word.matchAll(VARIABLE_REFERENCE)].map((m) => m[1] ?? m[2]))) {
    const known = values.get(name ?? "");
    if (known === undefined) continue;
    texts = texts.flatMap((text) =>
      [...new Set(known)].map((value) =>
        text.replace(VARIABLE_REFERENCE, (match, braced?: string, bare?: string) =>
          (braced ?? bare) === name ? value : match,
        ),
      ),
    );
    if (texts.length > MAX_READINGS)
      return { texts: texts.slice(0, MAX_READINGS), unplaceable: true };
  }
  return { texts, unplaceable: texts.some((text) => HAS_EXPANSION.test(text)) };
}
