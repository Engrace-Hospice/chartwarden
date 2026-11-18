/**
 * Programs that run a script they read from STDIN, which is no shell script the guard reads (wave 13, B10: R10-ADV-B10). `echo CMD | make -f -`,
 * `awk -f - <<< 'BEGIN{system("CMD")}'`, `expect <<< 'spawn bash -c "CMD"'` and `echo CMD | osascript` each run a command the text names, in a language of their
 * own (a makefile recipe, awk's `system`, Tcl's `spawn`/`exec`, AppleScript's `do shell script`). A shell fed on stdin is read as a script and `awk '…'` as a program;
 * these asked for nothing. They ask when something feeds them. `osascript -e '…'` and a script FILE are read by the rules for inline code and files, as before. Pure.
 */

const AWK = /^[gmn]?awk$/;
const MAKE = /^g?make$/;

/** Does a make or awk command line name stdin as its script file (`-f -`, `-f-`, `--file=-`, `--file -`, `--makefile=-`)? */
function filesFromStdin(args: readonly string[]): boolean {
  return args.some(
    (a, k) =>
      a === "-f-" ||
      /^--(?:file|makefile)=-$/.test(a) ||
      ((a === "-f" || a === "--file" || a === "--makefile") && args[k + 1] === "-"),
  );
}

/** The operands of a program: the words that do not start with a dash (a lone `-` is stdin and counts as none). */
const operands = (args: readonly string[]): string[] =>
  args.filter((a) => a !== "-" && !a.startsWith("-"));

/** Why the program, given its arguments, runs a script from stdin the guard cannot read; null when it does not. */
export function stdinScriptTool(prog: string, args: readonly string[]): string | null {
  if (MAKE.test(prog) && filesFromStdin(args)) return `${prog} -f -`;
  if (AWK.test(prog) && filesFromStdin(args)) return `${prog} -f -`;
  if (prog === "expect" && !args.includes("-c") && operands(args).length === 0) return "expect";
  if (prog === "osascript" && !args.includes("-e") && operands(args).length === 0) {
    return "osascript";
  }
  return null;
}

export const STDIN_SCRIPT_TOOL_REASON = (what: string): string =>
  `\`${what}\` runs a script it is fed on stdin (a makefile recipe, awk's \`system\`, Tcl's \`spawn\`, AppleScript's \`do shell script\`), and the guard cannot read it as a command line. Write the script to a file and read it first, or let a human decide.`;
