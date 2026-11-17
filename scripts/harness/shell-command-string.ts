/**
 * The command string a shell takes from its words (wave 11 part C, C4; round-8 R8-CR-2, R8-CR-6, a pre-existing hole since wave 3).
 * -----------------------------------------------------------------------------------------------------------------------------------
 * A shell reads ALL its options first and takes the command string from the first non-option word after them: `bash -c -- 'CMD'`, `bash -c
 * -x 'CMD'`, `bash -cx 'CMD'`, `bash -o pipefail -c 'CMD'`, `bash --norc -c 'CMD'`, `bash -O extglob -c 'CMD'`, `sh -ec 'CMD'`. The wave-3
 * reader looked for a word that was `-` plus letters ending in `c` and judged the word AFTER it, so any option between `-c` and the string,
 * and any cluster with `c` in front (`-cx`, `-ce`, `-cl`), judged the option (or nothing) and skipped every rule for the real command.
 * ONE helper now: used for every shell in the nested-string reader, for the `find -exec sh -c` read rule, and for the script-reader
 * check of `written-scripts.ts`. What is read, per shell (each checked against the installed bash, zsh and sh):
 *   - a short cluster is read getopt-style, letter by letter: `c` anywhere before a letter that takes a value means `-c`; `o` and `O` take the
 *     rest of the cluster, or the next word, as a value (`-o pipefail`, `-O extglob`, `+o x`); `+x`-style words are options and never `-c`;
 *   - a long option is a flag, except `--rcfile` and `--init-file` which take the next word (bash); `--` and a lone `-` end the options;
 *   - the first word after them is the command string, the rest are `$0 $1 …`;
 *   - fish, csh and tcsh take the NEXT word as the string (`fish -c STR`, `-C STR` runs it first), so both readings are returned; pwsh takes
 *     `-c|-Command|-command` and then the rest of the words as one command line.
 * An option the reader cannot place makes no guess: it returns every plausible string (at most 3) and the guard judges all of them. Pure.
 */

/** Shells the guard reads a command string from. */
export const COMMAND_SHELLS = /^(?:bash|sh|zsh|dash|ksh|fish|csh|tcsh|ash|pwsh|powershell)$/;

const VALUE_LONG = new Set(["--rcfile", "--init-file"]);
const PWSH = /^(?:pwsh|powershell)$/;
const PWSH_COMMAND = /^-(?:c|command|commandwithargs|cwa)$/i;
/** Options of fish that run a string: `-c STR`, `-C STR`, `--command=STR`, `--init-command=STR`. */
const FISH_LONG = /^--(?:command|init-command)(?:=(.*))?$/;

interface Scan {
  /** The words of `args` from where the operands start (after the options and a `--`). */
  readonly operands: readonly string[];
  /** Where in `args` the operands start. */
  readonly at: number;
  readonly sawC: boolean;
}

/** One getopt-style pass over a shell's options. */
function scan(args: readonly string[]): Scan {
  let sawC = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--" || a === "-") {
      i++;
      break;
    }
    if (a.startsWith("--")) {
      if (VALUE_LONG.has(a)) i++;
      continue;
    }
    if ((a[0] !== "-" && a[0] !== "+") || a.length === 1) break;
    for (let p = 1; p < a.length; p++) {
      const letter = a[p] as string;
      if (letter === "c" && a[0] === "-") {
        sawC = true;
      } else if (letter === "o" || letter === "O") {
        // the rest of the cluster is the option's value, or the next word is
        if (p === a.length - 1) i++;
        break;
      }
    }
  }
  return { operands: args.slice(i), at: i, sawC };
}

/** The command strings `prog args` may run through its `-c`, as many readings as the options leave plausible; empty when it runs none. */
export function shellCommandStrings(prog: string, args: readonly string[]): string[] {
  if (PWSH.test(prog)) {
    const at = args.findIndex((a) => PWSH_COMMAND.test(a));
    return at < 0 || args[at + 1] === undefined ? [] : [args.slice(at + 1).join(" ")];
  }
  const found = scan(args);
  const out: string[] = [];
  if (found.sawC && found.operands[0] !== undefined) out.push(found.operands[0]);
  // fish, csh and tcsh: `-c` takes the next word whatever it is (`fish -c -- x` runs `--`): every `c` cluster's value counts too
  if (/^(?:fish|csh|tcsh)$/.test(prog)) out.push(...commandOptionValues(args));
  if (prog === "fish") {
    for (const a of args) {
      const m = FISH_LONG.exec(a);
      if (m?.[1] !== undefined) out.push(m[1]);
    }
    args.forEach((a, k) => {
      if (a === "-C" && args[k + 1] !== undefined) out.push(args[k + 1] as string);
    });
  }
  return [...new Set(out)];
}

/** Does this shell run a command string (so its operands are not a script file)? */
export const runsCommandString = (prog: string, args: readonly string[]): boolean =>
  shellCommandStrings(prog, args).length > 0 || scan(args).sawC;

/**
 * The value of `-c STR` / `--command STR` of `su`, `script`, `flock`, `runuser`: a cluster holding `c` (`-qc`, `-lc`) takes what is attached
 * after the `c`, or the next word when the `c` is last. Every cluster is read, so `script -qc 'cmd' /dev/null` is the string `cmd`.
 */
export function commandOptionValues(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a === "--") break;
    if (a === "--command") out.push(args[++k] ?? "");
    else if (a.startsWith("--command=")) out.push(a.slice("--command=".length));
    else if (a.startsWith("--") || !a.startsWith("-")) continue;
    else {
      const c = a.indexOf("c", 1);
      if (c < 0) continue;
      const attached = a.slice(c + 1);
      if (attached === "") out.push(args[++k] ?? "");
      else out.push(attached);
    }
  }
  return out;
}
