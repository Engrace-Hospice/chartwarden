/**
 * Which programs cannot run a command, and what `awk` runs (wave 11, part D, D4; round-8 R8-ADV-6).
 * ------------------------------------------------------------------------------------------------
 * A database host variable set for a program that is not a database client is refused (`db-any-program.ts`): the program
 * reads it. Wave 10 exempted every "text tool", and several of them run a command: `PGHOST=<host> awk 'BEGIN{system("psql -c 1")}'`,
 * `sed '1e psql -c 1'`, `sed 's/x/psql/e'`, `vim -es -c '!psql'`, `bat --pager psql`, `sort --compress-program=psql`, a pager,
 * `git -c core.pager=psql`, `find -exec`, `xargs`. They run the client with the variable in its environment.
 *
 * - `CANNOT_EXECUTE`: only programs that cannot start another program by any option: they print, search by pattern, count,
 *   move or change files, or set a variable. Nothing that has a pager, an editor, an `-exec` or a `system` function is on it
 *   (`ag --pager CMD`, `ack --pager=CMD` and `rg --pre CMD` start one, so those three are inert only without that option; wave 12, F-6).
 * - `awk`, `sed` and `sort` are exempt only when their words are proven inert: an awk program with no `system(`, no pipe and no
 *   `getline`, a sed script of `p`, `d`, `q`, `n`, `=`, `y` and `s` commands whose flags are not `e` or `w`, a sort with no
 *   `--compress-program`. A program text the reader cannot place (`-f FILE`, a script it cannot split) is not proven inert.
 * - `awkCommandStrings`: the command lines an awk program runs (`system("…")`, `"…" | getline`, `print | "…"`) so every rule
 *   judges them as it judges a `bash -c` string; a pipe or `system` whose command is not a literal is reported as unplaced.
 * Pure.
 */

const CANNOT_EXECUTE =
  /^(?:echo|printf|cat|ls|cd|pwd|head|tail|wc|grep|egrep|fgrep|cut|tr|uniq|tee|test|\[|\[\[|true|false|:|which|type|date|sleep|mkdir|touch|rm|cp|mv|ln|chmod|chown|diff|jq|yq|export|declare|typeset|readonly|local|unset|set|alias|read|wait|exit|return|kill|basename|dirname|realpath|stat|file)$/;

const AWK = /^[gmn]?awk$/;

/**
 * The awks differ in what an option means: macOS's awk (BWK awk 20200816, recorded: `fixtures/harness-db-tool-options/awk/`) takes `-F`, `-v` and
 * `-f` with a value and IGNORES every other option letter ("unknown option -i ignored"), so the next word is the program; gawk (`-e SRC`,
 * `--source`, `-i FILE`, `-l LIB`, `-E FILE`, `-L X`) and mawk (`-W opt`) take a value there. `awk` is whichever the machine has, and gawk and
 * mawk are not installed here (unverified), so only the three options every awk reads with a value skip their word; EVERY other word is a
 * candidate program, and the value of an option one awk ignores is judged as the program it is under the awk that ignores it.
 */
const AWK_UNIVERSAL_VALUE_OPTION = /^-[Fvf]$/;
/** Options that take the program from a FILE the guard cannot read: `-f`, gawk's `--file`, `-E`/`--exec`, `-i`/`--include`, mawk's `-W exec`. */
const AWK_PROGRAM_FILE_OPTION = /^-[fEi]|^--(?:file|exec|include)(?:=|$)|^-W\s*exec/;

/** An awk program longer than this is not read for the commands it runs (its string literals are matched pairwise): not proven inert, and it asks. */
const MAX_AWK_PROGRAM_CHARS = 16 * 1024;

export interface AwkPrograms {
  /** Every word that can be the program text, whichever awk runs it: the bare words, the value of `-e` and `--source=`. */
  readonly programs: readonly string[];
  /** A program comes from a file (`-f FILE`): not readable here, a limit the doc states. */
  readonly fromFile: boolean;
}

/**
 * The candidate program texts of an awk command line (wave 12, F-6; round-9 R9-CR-4). Wave 11 took the first non-option word as THE program
 * and skipped the value of `-F -v -f` only, so `gawk -i inplace 'BEGIN{system("psql -c 1")}'` judged `inplace` and never the program. Now every
 * word that is not an option and not the value of `-F`, `-v` or `-f` is judged (the file operands too: a name has no `system(` in it),
 * and so is the attached value of `-e` and `--source=`.
 */
export function awkPrograms(args: readonly string[]): AwkPrograms {
  const programs: string[] = [];
  let fromFile = false;
  let literal = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (literal || !a.startsWith("-") || a === "-") programs.push(a);
    else if (a === "--") literal = true;
    else {
      fromFile ||= AWK_PROGRAM_FILE_OPTION.test(a) || (a === "-W" && args[k + 1] === "exec");
      if (AWK_UNIVERSAL_VALUE_OPTION.test(a)) k++;
      else if (/^-e./.test(a)) programs.push(a.slice(2));
      else if (/^--source=/.test(a)) programs.push(a.slice(a.indexOf("=") + 1));
    }
  }
  return { programs, fromFile };
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
    const { programs, fromFile } = awkPrograms(args);
    return (
      !fromFile &&
      programs.every((p) => p.length <= MAX_AWK_PROGRAM_CHARS && !AWK_RUNS.test(maskAwk(p)))
    );
  }
  if (prog === "sed") return sedIsInert(args);
  if (prog === "sort") return sortIsInert(args);
  if (prog === "ag" || prog === "ack") return !args.some((a) => /^--pager/.test(a));
  if (prog === "rg") return !args.some((a) => /^--(?:pre|hostname-bin)/.test(a));
  return (prog === "git" || prog === "gh") && gitIsInert(args);
}

// ----------------------------------------------------------------------------------------------------- awk's commands

const STRING_LITERAL = /"((?:[^"\\]|\\.)*)"/gs;

/** A pipe inside a string literal is text, not an operator: it is stored as this character while the program is scanned. */
const QUOTED_PIPE = "\u0001";

/**
 * The program with regular-expression literals replaced by `R` (`$1 ~ /a|b/` holds no pipe) and the pipes inside string
 * literals made inert (`split($0, a, "|")`). A `/` opens a regular expression when what came before it cannot end an operand
 * (an identifier, a number, `)`, `]` or a string: there it divides). Misreading one costs an ask, never a miss: the masked text
 * only decides which pipes are operators.
 */
function maskAwk(program: string): string {
  let out = "";
  for (let i = 0; i < program.length; i++) {
    const ch = program[i] as string;
    if (ch === '"') {
      out += ch;
      for (i++; i < program.length && program[i] !== '"'; i++) {
        const inner = program[i] as string;
        if (inner === "\\" && i + 1 < program.length) {
          out += inner + (program[++i] as string);
        } else out += inner === "|" ? QUOTED_PIPE : inner;
      }
      if (i < program.length) out += '"';
    } else if (ch === "/" && !/[\w$)\]"]$/.test(out.trimEnd())) {
      let inClass = false;
      for (i++; i < program.length; i++) {
        const inner = program[i] as string;
        if (inner === "\\") i++;
        else if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) break;
      }
      out += "R";
    } else out += ch;
  }
  return out;
}

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
  return [...expression.matchAll(STRING_LITERAL)]
    .map((m) => unescapeAwk((m[1] ?? "").replaceAll(QUOTED_PIPE, "|")))
    .join("");
}

export const AWK_UNPLACED_REASON =
  "This awk program runs a command whose text the guard cannot read (`system(cmd)`, `cmd | getline`, `print | cmd`, or a program file). A human decides.";

export interface AwkCommands {
  /** Command lines the program runs, as literals. */
  readonly commands: readonly string[];
  /** The program runs something whose command line is not a literal (`system(cmd)`, `cmd | getline`): the guard cannot read it. */
  readonly unplaced: boolean;
}

/** The commands an awk program runs through `system(…)`, `"…" | getline` and `print … | "…"`, in every candidate program of the command line. */
export function awkCommandStrings(prog: string, args: readonly string[]): AwkCommands {
  if (!AWK.test(prog)) return { commands: [], unplaced: false };
  // A program file (`-f FILE`) is not readable here: a limit the doc states, no ask for every `awk -f`.
  const commands: string[] = [];
  let unplaced = false;
  for (const program of awkPrograms(args).programs) {
    if (program.length > MAX_AWK_PROGRAM_CHARS) {
      unplaced = true;
      continue;
    }
    const found = commandsOfProgram(program);
    commands.push(...found.commands);
    unplaced ||= found.unplaced;
  }
  return { commands, unplaced };
}

/** The commands one awk program text runs. */
function commandsOfProgram(program: string): AwkCommands {
  const masked = maskAwk(program);
  const commands: string[] = [];
  let unplaced = false;
  const take = (expression: string): void => {
    const value = literalValue(expression);
    if (value === undefined) unplaced = true;
    else commands.push(value);
  };
  for (const m of masked.matchAll(/\bsystem\s*\(/g)) {
    take(balancedArgument(masked, m.index + m[0].length - 1));
  }
  // `"cmd" | getline`, `cmd | getline x`: the left side of the pipe is the command.
  for (const m of masked.matchAll(
    /((?:"(?:[^"\\]|\\.)*"\s*)+|[\w$]+)\s*(?<!\|)\|(?!\|)\s*getline\b/g,
  ))
    take(m[1] ?? "");
  // `print x | "cmd"`, `printf … | cmd`: the right side of a pipe that is not getline.
  for (const m of masked.matchAll(
    /(?<!\|)\|(?!\|)(?!\s*getline\b)\s*((?:"(?:[^"\\]|\\.)*"\s*)+|[\w$]+)/g,
  ))
    take(m[1] ?? "");
  return { commands, unplaced };
}
