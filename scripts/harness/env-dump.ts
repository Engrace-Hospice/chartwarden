/**
 * Commands that print the whole environment or a secret variable (wave 8, T5; round-6 ADV6-8, CR6-12): a dump of the environment
 * puts DATABASE_URL and vendor secrets into the transcript. `printenv`, `env`, `set` and `export` with no operand; `export -p`,
 * `export -px`, `declare -x`, `declare -p`, `declare -px`, `typeset -x`, `typeset -p` (a cluster of options that names
 * nothing); `ps eww`, `ps aux -E` and the BSD `e` modifier (a process's environment is printed beside it);
 * `launchctl export` and `launchctl getenv SECRET`; and the programs of `jq` that read `env` or `$ENV`.
 * `declare -x NAME=value` and `export NAME=value` ASSIGN: they name a variable, so they dump nothing (round-6 CR6-12: the
 * old rule denied them). Pure.
 */
import { environmentLeak, isSecretVariable } from "./secret-reads";

const REASON =
  "Dumping the environment would put DATABASE_URL and vendor secrets into the transcript. Print the one non-secret variable you need, by name.";

/** A word that is only options (`-p`, `-px`, `-0`): it names no variable. */
const isOptionsOnly = (a: string): boolean => /^-[A-Za-z0-9]*$/.test(a);

/** The letters that make `export`, `declare` and `typeset` list variables: `-p` (print) and `-x` (exported). */
const LISTS_VARIABLES = /^-[A-Za-z]*[px][A-Za-z]*$/;

/** BSD `ps` takes options without a dash; an `e` among them (`eww`, `auxe`) appends each process's environment. */
const BSD_PS_ENVIRONMENT = /^[A-Za-z]*e[A-Za-z]*w*$/;
/** `ps -E` (macOS) and `ps -ww -E`: the environment of each process. */
const DASH_PS_ENVIRONMENT = /^-[A-Za-z]*E[A-Za-z]*$/;

/** Why this command line dumps the environment (a deny), or null when it does not. */
export function environmentDumpReason(prog: string, args: readonly string[]): string | null {
  if (prog === "printenv" || prog === "env" || prog === "set")
    return args.length === 0 ? REASON : null;
  if (prog === "export" || prog === "declare" || prog === "typeset") {
    // No operand lists every variable; options alone list them when one says so (-p, -x); a NAME or NAME=value assigns.
    if (args.length === 0) return REASON;
    return args.every(isOptionsOnly) && args.some((a) => LISTS_VARIABLES.test(a)) ? REASON : null;
  }
  if (
    prog === "ps" &&
    // BSD options are the FIRST word (`ps eww $$`); a later word is a value (`ps -u me`) or a pid.
    args.some(
      (a, k) =>
        (k === 0 && !a.startsWith("-") && BSD_PS_ENVIRONMENT.test(a)) ||
        DASH_PS_ENVIRONMENT.test(a),
    )
  ) {
    return "`ps` with the environment modifier (`e`, `eww`, `-E`) prints every process's environment, secrets included, into the transcript.";
  }
  if (prog === "launchctl") {
    if (args[0] === "export") return REASON;
    if (args[0] === "getenv" && args.slice(1).some(isSecretVariable)) {
      return 'Printing a secret-bearing variable puts it in the transcript. Check presence with `[ -n "$VAR" ] && echo set` instead.';
    }
  }
  if (prog === "jq") {
    // The program of jq: every word that is not an option. `env` and `$ENV` read the environment.
    const leak = args.filter((a) => !a.startsWith("-")).map((a) => environmentLeak(a, "jq"));
    if (leak.includes("dump") || leak.includes("secret")) return REASON;
  }
  return null;
}
