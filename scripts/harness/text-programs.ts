/**
 * Which programs cannot run a command, and what `awk` runs (wave 11, part D, D4; round-8 R8-ADV-6).
 * ------------------------------------------------------------------------------------------------
 * A database host variable set for a program that is not a database client is refused (`db-any-program.ts`): the program
 * reads it. Wave 10 exempted every "text tool", and several of them run a command: `PGHOST=<host> awk 'BEGIN{system("psql -c 1")}'`,
 * `sed '1e psql -c 1'`, `sed 's/x/psql/e'`, `vim -es -c '!psql'`, `bat --pager psql`, `sort --compress-program=psql`, a pager,
 * `git -c core.pager=psql`, `find -exec`, `xargs`. They run the client with the variable in its environment.
 *
 * - `CANNOT_EXECUTE`: only programs that cannot start another program by any option: they print, search by pattern, count,
 *   move or change files, or set a variable. Nothing that has a pager, an editor, an `-exec` or a `system` function is on it.
 * - `awk`, `sed` and `sort` are exempt only when their words are proven inert: an awk program with no `system(`, no pipe and no
 *   `getline`, a sed script of `p`, `d`, `q`, `n`, `=`, `y` and `s` commands whose flags are not `e` or `w`, a sort with no
 *   `--compress-program`. A program text the reader cannot place (`-f FILE`, a script it cannot split) is not proven inert.
 * - `awkCommandStrings`: the command lines an awk program runs (`system("…")`, `"…" | getline`, `print | "…"`) so every rule
 *   judges them as it judges a `bash -c` string; a pipe or `system` whose command is not a literal is reported as unplaced.
 * Pure.
 */

const CANNOT_EXECUTE =
  /^(?:echo|printf|cat|ls|cd|pwd|head|tail|wc|grep|egrep|fgrep|rg|ag|ack|cut|tr|uniq|tee|test|\[|\[\[|true|false|:|which|type|date|sleep|mkdir|touch|rm|cp|mv|ln|chmod|chown|diff|jq|yq|export|declare|typeset|readonly|local|unset|set|alias|read|wait|exit|return|kill|basename|dirname|realpath|stat|file)$/;

const AWK = /^[gmn]?awk$/;

/** awk options that take the next word as their value. */
const AWK_VALUE_OPTION = /^-[Fvf]$|^--(?:field-separator|assign|file)$/;
const AWK_FILE_OPTION = /^-f$|^--file(?:=|$)|^-f./;

/** An awk program longer than this is not read for the commands it runs (its string literals are matched pairwise): not proven inert, and it asks. */
const MAX_AWK_PROGRAM_CHARS = 16 * 1024;

/** The program text of an awk command line, or undefined when it comes from a file (`-f FILE`). */
function awkProgram(args: readonly string[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (AWK_FILE_OPTION.test(a)) return undefined;
    if (AWK_VALUE_OPTION.test(a)) k++;
    else if (!a.startsWith("-")) return a;
  }
  return "";
}

const AWK_RUNS = /\bsystem\s*\(|(?<!\|)\|(?!\|)|\bgetline\b/;

/** One sed command: an optional address, then a print/delete/quit/next command, `y`, or an `s` whose flags run nothing. */
const SED_ADDRESS = String.raw`(?:\d+|\$|\/[^/]*\/)(?:,(?:\d+|\$|\/[^/]*\/))?!?`;
const SED_COMMAND = new RegExp(
  String.raw`^\s*(?:${SED_ADDRESS})?\s*(?:[pdqnN=Dg]|s([/|#,:@])((?:(?!\1)[^\\]|\\.)*)\1((?:(?!\1)[^\\]|\\.)*)\1[gpiIm0-9]*|y([/|#,:@])((?:(?!\4)[^\\]|\\.)*)\4((?:(?!\4)[^\\]|\\.)*)\4)\s*$`,
);

/** The sed scripts of a command line (`-e S`, `--expression=S`, or the first word), or undefined when one comes from a file. */
function sedScripts(args: readonly string[]): string[] | undefined {
  const scripts: string[] = [];
  let positional: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a === "-f" || /^--file(?:=|$)/.test(a) || /^-[A-Za-z]*f/.test(a)) return undefined;
    if (a === "-e" || a === "--expression") scripts.push(args[++k] ?? "");
    else if (a.startsWith("--expression=")) scripts.push(a.slice(13));
    else if (/^-[A-Za-z]*e./.test(a)) scripts.push(a.replace(/^-[A-Za-z]*e/, ""));
    else if (/^-[A-Za-z]*e$/.test(a)) scripts.push(args[++k] ?? "");
    else if (!a.startsWith("-") && positional === undefined && scripts.length === 0) positional = a;
  }
  return positional === undefined ? scripts : [positional, ...scripts];
}

/** Is every command of every script a plain `p`, `d`, `s///` ...? A `;` inside a pattern makes it unprovable, not inert. */
const sedIsInert = (args: readonly string[]): boolean => {
  const scripts = sedScripts(args);
  if (scripts === undefined) return false;
  return scripts.every((script) =>
    script.split(/[;\n]/).every((command) => command.trim() === "" || SED_COMMAND.test(command)),
  );
};

/** `sort --compress-program` runs a program (every GNU abbreviation of it: `--com`, `--compress`). */
const sortIsInert = (args: readonly string[]): boolean => !args.some((a) => /^--co/.test(a));

/**
 * `git` and `gh` print, stage and commit; they start another program only through `git -c core.pager=…` / `--config-env` (an
 * option that sets a command to run), a hook, or an alias or extension; the config options are the ones a command line can add.
 */
const gitIsInert = (args: readonly string[]): boolean =>
  !args.some(
    (a) =>
      a === "-c" ||
      /^-c./.test(a) ||
      a.startsWith("--config-env") ||
      a === "extension" ||
      a === "ext",
  );

/** Can this command run another program through its own words? false: a database variable set for it is read as for any program. */
export function textProgramIsInert(prog: string, args: readonly string[]): boolean {
  if (CANNOT_EXECUTE.test(prog)) return true;
  if (AWK.test(prog)) {
    const program = awkProgram(args);
    return (
      program !== undefined && program.length <= MAX_AWK_PROGRAM_CHARS && !AWK_RUNS.test(program)
    );
  }
  if (prog === "sed") return sedIsInert(args);
  if (prog === "sort") return sortIsInert(args);
  return (prog === "git" || prog === "gh") && gitIsInert(args);
}

// ----------------------------------------------------------------------------------------------------- awk's commands

const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/gs;

const unescapeAwk = (text: string): string => text.replace(/\\(.)/gs, "$1");

/** The text between the parenthesis that opens at `open` and its match (the rest of the program when it never closes). */
function balancedArgument(program: string, open: number): string {
  let depth = 0;
  let inString = false;
  for (let i = open; i < program.length; i++) {
    const ch = program[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return program.slice(open + 1, i);
  }
  return program.slice(open + 1);
}

/** Is the expression nothing but adjacent string literals (awk concatenates them)? Then its value is their text. */
function literalValue(expression: string): string | undefined {
  const rest = expression.replace(STRING_LITERAL, "").trim();
  if (rest !== "") return undefined;
  return [...expression.matchAll(STRING_LITERAL)].map((m) => unescapeAwk(m[1] ?? "")).join("");
}

export const AWK_UNPLACED_REASON =
  "This awk program runs a command whose text the guard cannot read (`system(cmd)`, `cmd | getline`, `print | cmd`, or a program file). A human decides.";

export interface AwkCommands {
  /** Command lines the program runs, as literals. */
  readonly commands: readonly string[];
  /** The program runs something whose command line is not a literal (`system(cmd)`, `cmd | getline`): the guard cannot read it. */
  readonly unplaced: boolean;
}

/** The commands an awk program runs through `system(…)`, `"…" | getline` and `print … | "…"`. */
export function awkCommandStrings(prog: string, args: readonly string[]): AwkCommands {
  if (!AWK.test(prog)) return { commands: [], unplaced: false };
  const program = awkProgram(args);
  if (program !== undefined && program.length > MAX_AWK_PROGRAM_CHARS)
    return { commands: [], unplaced: true };
  // A program file (`-f FILE`) is not readable here: a limit the doc states, no ask for every `awk -f`.
  if (program === undefined) return { commands: [], unplaced: false };
  const commands: string[] = [];
  let unplaced = false;
  const take = (expression: string): void => {
    const value = literalValue(expression);
    if (value === undefined) unplaced = true;
    else commands.push(value);
  };
  for (const m of program.matchAll(/\bsystem\s*\(/g)) {
    take(balancedArgument(program, m.index + m[0].length - 1));
  }
  // `"cmd" | getline`, `cmd | getline x`: the left side of the pipe is the command.
  for (const m of program.matchAll(
    /((?:"(?:[^"\\]|\\.)*"\s*)+|[\w$]+)\s*(?<!\|)\|(?!\|)\s*getline\b/g,
  ))
    take(m[1] ?? "");
  // `print x | "cmd"`, `printf … | cmd`: the right side of a pipe that is not getline.
  for (const m of program.matchAll(
    /(?<!\|)\|(?!\|)(?!\s*getline\b)\s*((?:"(?:[^"\\]|\\.)*"\s*)+|[\w$]+)/g,
  ))
    take(m[1] ?? "");
  return { commands, unplaced };
}
