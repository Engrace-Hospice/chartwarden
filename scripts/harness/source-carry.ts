/**
 * The variables a SOURCED text sets (wave 11, part D, D6; round-8 R8-ADV-12).
 * ------------------------------------------------------------------------------------------------
 * `eval 'export PGHOST=H'; psql` was refused: the statements of the eval string reach the commands after it. `source <(echo
 * export PGHOST=H); psql`, `. <(printf 'PGHOST=H\n'); psql` and `source /dev/stdin <<< 'export PGHOST=H'; psql` set the same
 * variable in the shell that runs `psql`, and the guard judged the sourced text only as a command line of its own, so the variable
 * was lost. This module returns the `NAME=value` words the sourced texts of a command line assign, for the variable tracker to
 * keep like any other statement, and whether a `source <( … )` text could not be read (`source <(curl …)`), so that a database
 * client after it asks: the sourced text may have set any variable.
 *
 * The parsing is injected (`SourceReaders`) because the lexer and the segment reader live in the classifier. Pure.
 */

const SOURCES = /^(?:source|\.)$/;

/** What the classifier lets this module do with a text. */
export interface SourceReaders {
  /** The text inside each `<( … )`, `$( … )` of a command's own text. */
  readonly substitutions: (text: string) => readonly string[];
  /** What each simple command of a text prints when it only prints (`echo`, `printf`), null for any other command. */
  readonly printedLines: (text: string) => ReadonlyArray<string | null>;
  /** The `NAME=value` words the variable statements of a text assign. */
  readonly statementsOf: (text: string) => readonly string[];
}

/** One simple command of the text, as far as this module reads it. */
export interface SourceCommand {
  readonly prog: string;
  readonly args: readonly string[];
  readonly strings: readonly string[];
}

export interface SourcedStatements {
  readonly words: readonly string[];
  /** A `source <( … )` whose text is produced by something that is not a plain print. */
  readonly unreadable: boolean;
}

const READS_STDIN = (args: readonly string[]): boolean =>
  args.some((a) => a === "/dev/stdin" || a === "-");

export function sourcedStatements(
  commands: readonly SourceCommand[],
  texts: readonly string[],
  bodies: ReadonlyArray<readonly string[]>,
  readers: SourceReaders,
): SourcedStatements {
  const words: string[] = [];
  let unreadable = false;
  for (const [index, command] of commands.entries()) {
    if (!SOURCES.test(command.prog)) continue;
    const printed: string[] = [];
    for (const inner of readers.substitutions(texts[index] ?? "")) {
      for (const line of readers.printedLines(inner)) {
        if (line === null) unreadable = true;
        else printed.push(line);
      }
    }
    if (READS_STDIN(command.args)) printed.push(...command.strings, ...(bodies[index] ?? []));
    for (const text of printed) words.push(...readers.statementsOf(text));
  }
  return { words, unreadable };
}
