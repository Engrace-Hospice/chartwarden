/**
 * Scripts the command line carries or hands on: inline interpreter code (`python3 -c`, `perl -e`, `awk '…'`),
 * a script an interpreter or a shell reads from stdin (`python3 -`, `bash <<< '…'`, `echo '…' | sh`), and the
 * text that `echo`/`printf` hands a shell. A script FILE is not here: the guard cannot read one. Pure.
 */

export const INTERPRETER =
  /^(python[0-9.]*|node|bun|deno|perl|ruby|php|awk|gawk|mawk|nawk|lua|osascript)$/;
/** A shell that runs the text it is handed. */
export const SHELL_PROGRAM = /^(bash|sh|zsh|dash|ksh|fish)$/;
const AWK = /^[gmn]?awk$/;

/** What an interpreter takes its code from, besides the generic `-c`/`-e`/`-p`/`-E`/`--eval`/`--print`. */
const INLINE_CODE = /\s(-c|-e|-p|-E|--eval|--print)\b/;
/**
 * A short-option cluster that ends in the code flag (`-Bc`, `-pe`, `-lane`, `-qr`), or one that starts with it
 * and carries the code attached (`-e'print 1'`): a cluster of letters and digits holding the interpreter's flag.
 */
const INLINE_FLAG: ReadonlyArray<readonly [prog: RegExp, flag: RegExp]> = [
  [/^python[0-9.]*$/, /^-[A-Za-z]*c/],
  [/^(node|bun|perl|ruby|lua|osascript)$/, /^-[A-Za-z0-9]*[eEp]/],
  [/^php$/, /^-[A-Za-z]*r/],
];

/** awk always takes its program inline; the others only behind a code flag (or `deno eval`). */
export function runsInlineCode(prog: string, args: readonly string[]): boolean {
  if (!INTERPRETER.test(prog)) return false;
  if (AWK.test(prog)) return true;
  if (prog === "deno" && args[0] === "eval") return true;
  if (INLINE_CODE.test(` ${args.join(" ")}`)) return true;
  return INLINE_FLAG.some(([name, flag]) => name.test(prog) && args.some((a) => flag.test(a)));
}

/** awk options that take the next word as their value. */
const AWK_VALUE_FLAG = /^-[Fvf]$|^--(?:field-separator|assign|file)$/;

/**
 * The text of the code an inline interpreter runs. awk's operands after its program are files it READS, so a
 * workflow file named there is not code that touches it; any other interpreter's arguments are all code or its
 * own operands, and are judged whole.
 */
export function inlineScriptText(prog: string, args: readonly string[]): string {
  if (!AWK.test(prog)) return args.join(" ");
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (AWK_VALUE_FLAG.test(a)) k++;
    else if (!a.startsWith("-")) return a;
  }
  return "";
}

/** Can the file operands of this inline interpreter be written by it? awk only reads them, unless gawk's `-i inplace`. */
export const mayWriteFileOperands = (prog: string, args: readonly string[]): boolean =>
  !AWK.test(prog) || args.some((a) => a === "inplace" || a === "-iinplace");

/** The parts of a parsed command this reads. */
export interface ScriptCommand {
  readonly prog: string;
  readonly args: readonly string[];
  readonly ins: readonly string[];
  readonly docs: readonly string[];
}

/**
 * A program whose script arrives on stdin: `python3 -`, `node <<EOF`, `… | python3`, `bash <<< '…'`, `… | sh -s`.
 * Not an interpreter with inline code, a `bash -c '…'` (the script is an operand), or one that names a script FILE.
 */
export function readsScriptFromStdin(p: ScriptCommand, index: number): boolean {
  const shell = SHELL_PROGRAM.test(p.prog);
  if (!shell && (!INTERPRETER.test(p.prog) || AWK.test(p.prog) || runsInlineCode(p.prog, p.args))) {
    return false;
  }
  const positional = p.args.filter((a) => !a.startsWith("-") || a === "-");
  if (p.args.some((a) => /^(-v|-V|-h|--version|--help)$/.test(a))) return false;
  return (
    positional[0] === "-" ||
    (positional.length === 0 && (index > 0 || p.ins.length + p.docs.length > 0))
  );
}

// ---------------------------------------------------------------------------------------------------
// The text `echo` and `printf` hand to a shell
// ---------------------------------------------------------------------------------------------------

/** Escapes a printing command turns into characters: a literal `\n` in `echo -e` and in a printf format. */
const unescapePrinted = (t: string): string =>
  t.replace(/\\([nt\\])/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : "\\"));

const FORMAT_CONVERSION = /%[-+ 0#]*\d*(?:\.\d+)?[sbdiouxXcq]/g;

/** `printf FORMAT ARG…`: the format is reused until the arguments run out, each conversion taking the next one. */
function printfOutput(format: string, values: readonly string[]): string {
  const conversions = format.match(FORMAT_CONVERSION)?.length ?? 0;
  if (conversions === 0 || values.length === 0) return format;
  let out = "";
  let next = 0;
  for (let rounds = 0; next < values.length && rounds < values.length; rounds++) {
    out += format.replace(FORMAT_CONVERSION, () => values[next++] ?? "");
  }
  return out;
}

/** What `echo` or `printf` writes, as a script text; null for any other command. */
export function printedText(prog: string, args: readonly string[]): string | null {
  if (prog === "echo") return unescapePrinted(args.filter((a) => !/^-[neE]+$/.test(a)).join(" "));
  if (prog !== "printf") return null;
  const operands = args.filter((a) => a !== "--");
  return unescapePrinted(printfOutput(operands[0] ?? "", operands.slice(1)));
}

/** One command of a line: its program, arguments and the operator that joined it to the one before. */
export interface ScriptStage extends ScriptCommand {
  readonly joiner: string;
  /** Here-string words (`<<< 'text'`). */
  readonly strings: readonly string[];
}

/** The scripts handed to the shell at `index`, and whether some of what it reads is text the guard cannot see. */
export interface HandedScripts {
  readonly texts: string[];
  readonly unreadable: boolean;
}

/**
 * What the shell at `stages[index]` reads as its script: a here-string, and what the `echo` or `printf` before
 * it in its pipeline prints. A pipeline into a shell from anything else (`curl … | sh`, `cat f | bash`) is a
 * script the guard cannot read. A shell that was not handed stdin has none.
 */
export function scriptsHandedToShell(stages: readonly ScriptStage[], index: number): HandedScripts {
  const none: HandedScripts = { texts: [], unreadable: false };
  const shell = stages[index] as ScriptStage;
  if (!readsScriptFromStdin(shell, index) || !SHELL_PROGRAM.test(shell.prog)) return none;
  const texts = shell.strings.map(unescapePrinted);
  let unreadable = false;
  for (let j = index; stages[j]?.joiner === "|"; j--) {
    const source = stages[j - 1] as ScriptStage;
    const printed = printedText(source.prog, source.args);
    if (printed !== null) texts.push(printed);
    // A heredoc's body is judged line by line already (`cat <<EOF | sh`); anything else is unseen text.
    else if (source.docs.length === 0) unreadable = true;
  }
  return { texts, unreadable };
}
