/**
 * The vocabulary the database-client readers share (`db-client-escapes.ts` and the modules it uses): what a reading of a
 * command text finds, and the small helpers that read a token. Pure.
 */

/** What one client was handed to run, by what the guard should do about it. */
export interface ClientFindings {
  /** Escapes that run a program or load code; whatever they name, a human decides. */
  readonly shell: readonly string[];
  /** Files the client writes: judged like a redirect target. */
  readonly writes: readonly string[];
  /** Files the client reads and runs or prints: a secret one is refused. */
  readonly reads: readonly string[];
}

/** One reading of a command line: what it runs, writes and reads. */
export type Reading = Partial<ClientFindings>;

export const LINE_BREAK = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;
export const isOption = (t: string): boolean => t.startsWith("-");
export const isPipe = (t: string): boolean => t.startsWith("|");
/** A target that names the terminal or switches logging off, not a file. */
const NOT_A_FILE = new Set(["stdout", "stderr", "off", "-", ":memory:"]);

/** A word the client reads as one token: surrounding quotes removed (`'/tmp/a b.csv'`). */
export const unquote = (t: string): string => t.replace(/^(['"])(.*)\1$/s, "$2");

/** The blank-separated tokens of an argument line, a quoted token kept whole. */
export function tokens(rest: string): string[] {
  return (rest.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(unquote);
}

export const shellOf = (what: string): Reading => ({ shell: [what] });
export const writeOf = (file: string | undefined): Reading =>
  file === undefined || file === "" || NOT_A_FILE.has(file) ? {} : { writes: [file] };
export const readOf = (file: string | undefined): Reading =>
  file === undefined || file === "" ? {} : { reads: [file] };

/** What the shell leaves of an argument written in double quotes: `"\\o X"` is `\o X`, `\"` is `"`. */
const DOUBLE_QUOTE_ESCAPE = /\\(["\\$`])/g;

/**
 * The readings of one argument: as the guard lexed it, and as a client receives it once the shell has reduced the
 * backslashes of a double-quoted word. The lexer keeps `\\` as two characters, so `psql -c "\\o X"` was never read as
 * `\o X`. Both are read: a single-quoted `'\\o X'` reaches psql as `\\o X` (a separator, then `o X`), and reading its
 * reduced form too costs nothing but an ask for a command nobody types.
 */
export function bothReadings(text: string): string[] {
  const reduced = text.replace(DOUBLE_QUOTE_ESCAPE, "$1");
  return reduced === text ? [text] : [text, reduced];
}

/** `dir` joined to a relative `file`, as the client resolves it after a `cd` (`.cd`, `\cd`); an absolute file is itself. */
export function inDirectory(dir: string, file: string | undefined): string | undefined {
  if (file === undefined || dir === "" || file.startsWith("/") || file.startsWith("~")) return file;
  return `${dir}/${file}`;
}

/** The directory after a `cd target` from `dir`. */
export function changeDirectory(dir: string, target: string | undefined): string {
  if (target === undefined || target === "") return dir;
  return target.startsWith("/") || target.startsWith("~") || dir === ""
    ? target
    : `${dir}/${target}`;
}
