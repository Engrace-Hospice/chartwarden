/**
 * Program words the shell builds by expansion (wave 11 part C, C8; round-8 R8-ADV-7). Two spellings name a program the lexer takes for a
 * file name: zsh's `=psql -h H` (an `=` before a command name is the path of that command, `setopt equals`, on by default) and
 * `psql${IFS}-h${IFS}H` (an unquoted `$IFS` splits the word into the program and its arguments). `{psql,-h,H}` is a brace expansion of the
 * same kind and `shell-lex.ts` keeps it whole now (`ungroup` removed its leading `{` as if it opened a command group). Each is read as the
 * words it expands to; the classifier judges that command and, for `$IFS`, also asks (IFS can be changed). Pure.
 */

export interface StoodFor {
  /** The program, as the last path component. */
  readonly prog: string;
  /** The arguments the word itself holds (those of `$IFS` splitting). */
  readonly args: readonly string[];
  /** The word held `$IFS`: what it expands to depends on a variable the guard does not track. */
  readonly ifs: boolean;
}

const EQUALS_COMMAND = /^=([A-Za-z_][\w.+-]*)$/;
const IFS_REFERENCE = /\$\{IFS\}|\$IFS(?![A-Za-z0-9_])/g;

/** What a program word stands for after zsh's `=name` or `$IFS` splitting, or null when it holds neither. */
export function expandedProgramWord(word: string): StoodFor | null {
  const equals = EQUALS_COMMAND.exec(word);
  if (equals !== null) return { prog: equals[1] as string, args: [], ifs: false };
  if (!word.includes("IFS")) return null;
  const split = word.replace(IFS_REFERENCE, " ");
  if (split === word) return null;
  const pieces = split.split(/\s+/).filter((piece) => piece !== "");
  const [first, ...args] = pieces;
  if (first === undefined) return null;
  return { prog: first.replace(/^.*\//, ""), args, ifs: true };
}
