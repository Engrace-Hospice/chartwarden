/**
 * Does a command line hold a brace group the SHELL would expand? (wave 7, CR5-1)
 * -------------------------------------------------------------------------------------------------
 * `{c,'x y'}` is an unquoted group: the braces and the comma are bare, one alternative holds a quoted space, and bash
 * expands it. `'{"a":1,"b":2}'` is not: its braces are inside quotes. The classifier expands brace groups in every word
 * (the quotes are gone from the word), and when the budget cuts a word it asks only if the shell would have expanded one,
 * so the question is asked of the lexer, which knows which characters are bare, never of whitespace in the word. Pure.
 */
import { BARE, scanShell } from "./shell-lex";

const SEQUENCE_BODY = /^(?:-?\d+|[A-Za-z])\.\.(?:-?\d+|[A-Za-z])(?:\.\.-?\d+)?$/;

/** Is there an unquoted `{…,…}` or `{a..b}` in this command text? One linear scan. */
export function hasBareBraceGroup(text: string): boolean {
  if (!text.includes("{")) return false;
  const { kind } = scanShell(text, false);
  let open = -1;
  let comma = false;
  for (let i = 0; i < text.length; i++) {
    if (kind[i] !== BARE) continue;
    const ch = text[i];
    if (ch === "{") {
      open = i;
      comma = false;
    } else if (ch === ",") comma ||= open >= 0;
    else if (ch === "}" && open >= 0) {
      if (comma || SEQUENCE_BODY.test(text.slice(open + 1, i))) return true;
      open = -1;
    }
  }
  return false;
}
