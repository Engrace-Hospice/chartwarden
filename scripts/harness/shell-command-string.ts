/**
 * The command string a shell takes from its words (wave 11 part C, C4; wave 12 part E1, E1-1: per-shell tables).
 * -----------------------------------------------------------------------------------------------------------------------------------
 * A shell reads ALL its options first and takes the command string from the first non-option word after them: `bash -c -- 'CMD'`, `bash -c
 * -x 'CMD'`, `bash -cx 'CMD'`, `bash -o pipefail -c 'CMD'`, `bash --norc -c 'CMD'`, `bash -O extglob -c 'CMD'`, `sh -ec 'CMD'`. Which words are
 * options is NOT the same in every shell (`shell-grammars.ts` says how each reads `+c`, `-o`, `-O`, the rest of a cluster; the fixtures of
 * `harness-shell-options/` are the recordings from the installed bash, sh, dash, zsh, ksh and tcsh/csh). ONE reader, per-shell data, used for
 * every shell in the nested-string reader, for the `find -exec sh -c` read rule, and for the script-reader check of `written-scripts.ts`.
 *   - a short cluster is read letter by letter: `c` anywhere means `-c` (`+c` too where the shell reads it so); a letter that takes a value
 *     takes the NEXT word, or the rest of the cluster, as its table says, and the scan goes on (`-oc VAL`); `--` and a lone `-` end options;
 *   - a long option is a flag, except the valued ones of the table; the first word after the options is the command string and the words
 *     after it are `$0 $1 …`: a string that uses them (`exec "$@"`, `$1`) runs those words, so they are judged as a command line too;
 *   - ksh93 runs its first operand as a command line when no file of that name exists, whether or not `-c` was given;
 *   - csh and tcsh take the NEXT word after every `c` of a cluster (the last one is the command); fish takes the next word or the rest of the
 *     word, and `-C`/`--init-command` too; pwsh takes `-c|-Command|-command` and then the rest of the words as one command line.
 * An option the reader cannot place makes no guess: it returns every plausible string (at most 3) and the guard judges all of them. Pure.
 */
import { SHELL_GRAMMARS, type ShellGrammar } from "./shell-grammars";
import { joinedAndQuoted } from "./shell-quote";

/** Shells the guard reads a command string from. */
export const COMMAND_SHELLS = /^(?:bash|sh|zsh|dash|ksh|fish|csh|tcsh|ash|pwsh|powershell)$/;

const PWSH = /^(?:pwsh|powershell)$/;
const PWSH_COMMAND = /^-(?:c|command|commandwithargs|cwa)$/i;
/** Options of fish that run a string: `-c STR`, `-C STR`, `--command=STR`, `--init-command=STR`. */
const FISH_LONG = /^--(?:command|init-command)(?:=(.*))?$/;
/** A string that reads the operands after `$0`: `"$@"`, `$*`, `$1`, `${1}`, `${@:2}`. */
const READS_REST = /\$\{?[@*1-9]/;
/** A string that runs its first operand: `$0`, `"$0" "$@"`. */
const READS_ZERO = /\$\{?0(?![0-9])/;

/** A word that starts an option (`-x`, `+x`, `--`): ksh's `-o` lists the options instead of taking it; a lone `-` it does take (probed). */
const DASH_WORD = /^[-+]./;

interface Scan {
  /** The words of `args` from where the operands start (after the options and a `--`). */
  readonly operands: readonly string[];
  readonly sawC: boolean;
}

/** One getopt-style pass over a shell's options, read with the grammar of that shell. */
function scan(grammar: ShellGrammar, args: readonly string[]): Scan {
  let sawC = false;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--" || a === "-") {
      i++;
      break;
    }
    if (a.startsWith("--")) {
      if (grammar.valuedLong.includes(a)) i++;
      continue;
    }
    if ((a[0] !== "-" && a[0] !== "+") || a.length === 1) break;
    const plus = a[0] === "+";
    for (let p = 1; p < a.length; p++) {
      const letter = a[p] as string;
      if (letter === "c" && (!plus || grammar.plusC)) {
        sawC = true;
        continue;
      }
      const kind = grammar.valued[letter];
      if (kind === undefined) continue;
      if (kind === "next") {
        i++;
        continue;
      }
      const next = args[i + 1];
      const attached = p + 1 < a.length;
      if (
        !attached &&
        next !== undefined &&
        !(kind === "rest-or-next-unless-dash" && DASH_WORD.test(next))
      )
        i++;
      break;
    }
  }
  return { operands: args.slice(i), sawC };
}

/** `csh -cc A B` runs B: every `c` of a `-` cluster takes the next word, a later one replaces an earlier one, ``-b` ends the options after its word. */
function cshCommandStrings(args: readonly string[]): string[] {
  let command: string | undefined;
  let stop = false;
  for (let i = 0; i < args.length && !stop; i++) {
    const a = args[i] as string;
    if (!a.startsWith("-") || a === "-") break;
    for (const letter of a.slice(1)) {
      if (letter === "b") stop = true;
      else if (letter === "c") command = args[++i] ?? command;
    }
  }
  return command === undefined ? [] : [command];
}

/** fish: `-c STR`, `-cSTR`, `--command=STR`, `-C STR` (run first), every spelling counts. */
function fishCommandStrings(args: readonly string[]): string[] {
  const out = commandOptionValues(args);
  for (const [k, a] of args.entries()) {
    const m = FISH_LONG.exec(a);
    if (m?.[1] !== undefined) out.push(m[1]);
    if (a === "-C" && args[k + 1] !== undefined) out.push(args[k + 1] as string);
  }
  return out;
}

/**
 * The lines a string that reads its operands runs besides itself (R9-ADV-12: `sh -c 'exec "$@"' _ CMD`, `find -exec sh -c '"$@"' _ CMD \\;`): the operands
 * behind the string, joined and quoted back, from `$1` on when the string reads `$@`, `$*` or `$1`, from `$0` when it reads `$0`. The placeholder that
 * fills `$0` (`_`, `sh`) is no part of the command in the first case, so it is left out there.
 */
function operandLines(string: string, behind: readonly string[]): string[] {
  const lines = [
    ...(READS_REST.test(string) ? joinedAndQuoted(behind.slice(1)) : []),
    ...(READS_ZERO.test(string) ? joinedAndQuoted(behind) : []),
  ];
  return lines.filter((line) => line.trim() !== "");
}

/** What one grammar makes of the words: the string `-c` runs and the lines its operands may run, or the ksh operand run as a command. */
function grammarStrings(grammar: ShellGrammar, args: readonly string[]): string[] {
  const { operands, sawC } = scan(grammar, args);
  const [first, ...behind] = operands;
  if (first === undefined) return [];
  if (sawC) return [first, ...operandLines(first, behind)];
  return grammar.operandRuns ? [first, ...joinedAndQuoted(operands)] : [];
}

/** The command strings `prog args` may run through its `-c`, as many readings as the options leave plausible; empty when it runs none. */
export function shellCommandStrings(prog: string, args: readonly string[]): string[] {
  if (PWSH.test(prog)) {
    const at = args.findIndex((a) => PWSH_COMMAND.test(a));
    return at < 0 || args[at + 1] === undefined ? [] : [args.slice(at + 1).join(" ")];
  }
  if (prog === "csh" || prog === "tcsh") return cshCommandStrings(args);
  const out = (SHELL_GRAMMARS.get(prog) ?? []).flatMap((grammar) => grammarStrings(grammar, args));
  // fish is read as bash too (unverified: not installed here): both readings are judged
  return [...new Set(prog === "fish" ? [...out, ...fishCommandStrings(args)] : out)];
}

/** Does this shell run a command string with `-c` (so its operands are not a script file)? */
export const runsCommandString = (prog: string, args: readonly string[]): boolean =>
  (SHELL_GRAMMARS.get(prog) ?? []).some((grammar) => scan(grammar, args).sawC) ||
  (!SHELL_GRAMMARS.has(prog) && shellCommandStrings(prog, args).length > 0) ||
  (prog === "fish" && fishCommandStrings(args).length > 0);

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

/**
 * What `su USER -- -c 'CMD'` runs (R9-ADV-21): su hands every word after the login name to the target's shell, and a `--` is su's own or the
 * shell's (macOS `su` passes everything after the login name on; GNU `su` is not installed here, so which one eats the `--` is unverified, and
 * `su` needs a password so it was not run): the words after the first `--` are read as the arguments of bash, zsh and ksh. Read with the
 * `--` kept, they name a script file, which is no command string.
 */
export function suCommandStrings(args: readonly string[]): string[] {
  const dash = args.indexOf("--");
  const out = commandOptionValues(args);
  if (dash < 0) return out;
  const rest = args.slice(dash + 1);
  for (const shell of ["bash", "zsh", "ksh"]) out.push(...shellCommandStrings(shell, rest));
  return [...new Set(out)];
}
