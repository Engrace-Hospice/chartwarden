/**
 * Interpreters that run code the command line carries (`python3 -c`, `perl -e`, `awk '…'`), or read it from
 * stdin (`python3 -`, `node <<EOF`, `… | python3`). Moved out of `patterns.ts` unchanged; pure.
 */

export const INTERPRETER = /^(python[0-9.]*|node|bun|deno|perl|ruby|php|awk|gawk|lua)$/;
const INLINE_CODE = /\s(-c|-e|-p|-E|--eval|--print)\b/;

/** awk always takes its program inline; the others only behind -c/-e/-p/--eval. */
export const runsInlineCode = (prog: string, args: readonly string[]): boolean =>
  INTERPRETER.test(prog) && (/^g?awk$/.test(prog) || INLINE_CODE.test(` ${args.join(" ")}`));

/** The parts of a parsed command this reads. */
export interface ScriptCommand {
  readonly prog: string;
  readonly args: readonly string[];
  readonly ins: readonly string[];
  readonly docs: readonly string[];
}

/** An interpreter whose script arrives on stdin: `python3 -`, `node <<EOF`, `… | python3`. */
export function readsScriptFromStdin(p: ScriptCommand, index: number): boolean {
  if (!INTERPRETER.test(p.prog) || /^g?awk$/.test(p.prog) || runsInlineCode(p.prog, p.args)) {
    return false;
  }
  const positional = p.args.filter((a) => !a.startsWith("-") || a === "-");
  if (p.args.some((a) => /^(-v|-V|-h|--version|--help)$/.test(a))) return false;
  return (
    positional[0] === "-" ||
    (positional.length === 0 && (index > 0 || p.ins.length + p.docs.length > 0))
  );
}
