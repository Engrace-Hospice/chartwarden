/**
 * Words written back as one command line (moved out of `wrappers.ts` in wave 12 part E1 so the shell reader can use them without an import
 * cycle; `wrappers.ts` re-exports both). Pure.
 */

/**
 * A word as the shell must read it back as one word. A single quote is written `'"'"'` (close, a double-quoted quote, reopen), never `'\''`:
 * every reader that lexes the text again WITHOUT decoding backslashes (the readers of `db-connect-commands.ts` see the words as typed) would
 * keep the backslash and read `(\'host=H\')` where the shell reads `('host=H')` (R8-CR-3). Both spellings are the same word to a shell.
 */
export const shellQuote = (w: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'"'"'`)}'`;

/**
 * The words a wrapper hands to a shell as ONE string: the shell reads them joined by spaces, and the user meant them as the words they typed,
 * so both are judged (`watch bash -c -- 'CMD'`: joined, the string is only the first word).
 */
export function joinedAndQuoted(words: readonly string[]): string[] {
  const joined = words.join(" ");
  // one word is one command line already (`watch 'rm x'`): quoting it back would name a program called `rm x`
  if (words.length < 2) return [joined];
  const quoted = words.map(shellQuote).join(" ");
  return quoted === joined ? [joined] : [joined, quoted];
}
