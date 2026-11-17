/**
 * A script written and run by the same command line (wave 4, T5).
 * ----------------------------------------------------------------------------------------------------
 * `cat > /tmp/x.sh <<'EOF' … EOF` then `bash /tmp/x.sh`: a heredoc body is data, so the text only reaches the guard
 * if the command that runs the file is matched with the command that wrote it. A command writes a file with text
 * the guard can read when it is `cat`/`tee` fed by a heredoc, a here-string or a printed literal before a pipe, or
 * `echo`/`printf` with a literal string, redirected to the file. A later command runs that file when it is a shell
 * (`bash F`, `sh F`, `source F`, `. F`, `bash < F`), an interpreter (`python3 F`, `node F`, `bun run F`) or the file
 * itself (`./F`, `/tmp/F`). The caller matches the two paths the way it matches every path (against each directory
 * the command may run in) and judges the written text as the script it is. A text heuristic: a file written by an
 * earlier tool call, built from a variable or a command's output, or edited in place stays unread. Pure.
 */
import { SHELL_PROGRAM, printedTexts, runsInlineCode } from "./inline-code";
import { runsCommandString } from "./shell-command-string";

/** The parts of a parsed command the writer side reads. */
export interface WriterCommand {
  readonly prog: string;
  readonly args: readonly string[];
  /** Files its stdout is redirected to. */
  readonly outs: readonly string[];
  /** Here-doc delimiters and here-string words (a here-string is in both lists). */
  readonly docs: readonly string[];
  /** The here-string words alone. */
  readonly strings: readonly string[];
  /** The program and arguments, and the here-string words, as the program is HANDED them (an escaped quote is the quote; R9-CR-2). */
  readonly handed?: { readonly prog: string; readonly args: readonly string[] };
  readonly handedStrings?: readonly string[];
}

export interface WrittenText {
  /** The file as written in the command. */
  readonly target: string;
  /** What the command puts in it. */
  readonly text: string;
}

/** How many here-docs a command holds (its here-strings are counted among its docs). */
export const heredocCount = (p: Pick<WriterCommand, "docs" | "strings">): number =>
  Math.max(0, p.docs.length - p.strings.length);

const NOT_A_FILE = /^(?:\/dev\/(?:null|stdout|stderr|tty)|-)$/;

/**
 * The files `p` writes with text the guard can read. `bodies` are its own here-doc bodies, `piped` what the
 * `echo`/`printf` right before it in its pipeline prints (null for none).
 */
export function writtenTexts(
  p: WriterCommand,
  bodies: readonly string[],
  piped: string | null,
): WrittenText[] {
  let text: string | null;
  let targets: readonly string[] = p.outs;
  if (p.prog === "echo" || p.prog === "printf") text = printedTexts(p)?.join("\n") ?? null;
  else if (p.prog === "cat" || p.prog === "tee") {
    const typed = [...bodies, ...p.strings, ...(p.handedStrings ?? [])];
    text = typed.length > 0 ? typed.join("\n") : piped;
    if (p.prog === "tee") targets = [...targets, ...p.args.filter((a) => !a.startsWith("-"))];
  } else return [];
  if (text === null || text.trim() === "") return [];
  const body = text;
  return targets
    .filter((t) => t !== "" && !NOT_A_FILE.test(t))
    .map((target) => ({ target, text: body }));
}

/** What a command runs from a file: the file as written, and how its text is read. */
export interface FileRun {
  readonly path: string;
  /** `shell`: judged as a command line. `script`: judged as interpreter code. `direct`: either, by its first line. */
  readonly kind: "shell" | "script" | "direct";
}

/** Interpreters that run a script file (not awk, whose program is inline, nor osascript). */
const FILE_INTERPRETER = /^(?:python[0-9.]*|node|bun|deno|perl|ruby|php|lua|tsx|ts-node)$/;
const SCRIPT_SHEBANG = /^#!.*\b(?:python[0-9.]*|node|bun|deno|perl|ruby|php|lua|tsx|ts-node)\b/;

/** A shell's options that take the next word as their value. */
const SHELL_VALUE_OPTION = /^[-+][oO]$|^--(?:rcfile|init-file)$/;

/** The first operand after the options, or undefined. `-` (stdin) and `--` are not operands. */
function firstOperand(args: readonly string[], valueOption: RegExp): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (valueOption.test(a)) k++;
    else if (a !== "-" && a !== "--" && !a.startsWith("-") && !a.startsWith("+")) return a;
  }
  return undefined;
}

/** How a command reads a script: as shell text, as interpreter code, or not at all (`bash -c CODE`, `node -e CODE`). */
function runnerKind(prog: string, args: readonly string[]): "shell" | "script" | null {
  if (prog === "source" || prog === ".") return "shell";
  if (SHELL_PROGRAM.test(prog)) return runsCommandString(prog, args) ? null : "shell";
  return FILE_INTERPRETER.test(prog) && !runsInlineCode(prog, args) ? "script" : null;
}

/**
 * The files `prog args` runs. `word` is the program as typed (`./x.sh`), `ins` the files it reads on stdin (`bash <
 * F`, used when no operand names one).
 */
export function fileRuns(
  prog: string,
  word: string,
  args: readonly string[],
  ins: readonly string[],
): FileRun[] {
  const direct: FileRun[] = word.includes("/") ? [{ path: word, kind: "direct" }] : [];
  const kind = runnerKind(prog, args);
  if (kind === null) return direct;
  // `bun run F` and `deno run F`: `run` is the subcommand, the operand after it the file.
  const rest =
    /^(?:bun|deno)$/.test(prog) && args.includes("run")
      ? args.slice(args.indexOf("run") + 1)
      : args;
  const file = firstOperand(rest, kind === "shell" ? SHELL_VALUE_OPTION : /^$/);
  return [...direct, ...(file === undefined ? ins : [file]).map((path) => ({ path, kind }))];
}

/** Is a directly run file's text interpreter code (its first line names an interpreter) and not shell? */
export const isScriptText = (text: string): boolean =>
  SCRIPT_SHEBANG.test(text.trimStart().split("\n", 1)[0] ?? "");
