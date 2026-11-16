/**
 * The harness-switch rule: does one command line switch off, or re-point, part of the agent harness?
 * -------------------------------------------------------------------------------------------------
 * A variable such as `CODEX_HOME` or `CW_STOP_GATE` turns a guard, the ledger or the Stop gate off, or points an
 * agent at a configuration directory that has no hooks. The rule asks (a human decides) when one is
 *
 *   - assigned: `NAME=v cmd`, `export NAME=v`, `env NAME=v cmd`, also `NAME+=v` and `${NAME:=v}`;
 *   - named for the shell or the session to set: `printf -v NAME`, `read NAME`, `launchctl setenv NAME v`,
 *     `tmux set-environment NAME v`, `defaults write d NAME v`, `for NAME in …`;
 *   - spelled with quotes, backslashes or a brace group in between (`CODEX_HO\ME=x`, `CODEX_HOME{,}=x`);
 *   - or carried anywhere in the text of a command that is not a plain print or search (`ssh h 'NAME=x cmd'`).
 *
 * A command that only prints or searches, and whose output goes nowhere but another filter, may MENTION the
 * name (`rg CODEX_HOME= docs`): that text sets nothing. "Only prints" is judged by what the command can DO, not
 * by its name: `sort -o FILE`, `uniq IN OUT`, `sed 'w FILE'` write a file, `git grep -O CMD`, `rg --pre CMD` and
 * `ag --pager CMD` run a command line, so none of them is a print.
 *
 * Pure: the caller hands over the parsed commands, so this module imports nothing from the classifier.
 */
import { isLongInPlace, longName, spellsLong } from "./option-values";
import {
  ASSIGN,
  VARIABLE_SETTERS,
  assignments,
  hasParameterAssignment,
  hasUnplaceableName,
  shellWords,
} from "./shell-assignments";

/** The names of the variables the rule guards. `HOME` moves what `~` and `$HOME` mean. */
const GUARDED: ReadonlySet<string> = new Set([
  "CW_STOP_GATE",
  "CW_AGENT_LEDGER",
  "CW_HARNESS_FAIL_OPEN",
  "CW_HARNESS_ROOT_FOR_TESTS",
  "ECC_DISABLED_HOOKS",
  "ECC_GATEGUARD",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_PROJECT_DIR",
  "HOME",
]);
/** The name and an assignment operator ANYWHERE in a command's text, quotes and nested strings included. */
const SWITCH_TEXT = new RegExp(`\\b(?:${[...GUARDED].join("|")})${ASSIGN}`);
/** What may sit inside a name the shell still reads as the name: quotes, backslashes, a brace group. */
const OBFUSCATION = /[\\'"{},]/g;

/** Programs whose own arguments assign variables (`export NAME=value`; `env` is a wrapper the word reader peels). */
const VARIABLE_SETTER = new RegExp(`^(?:${VARIABLE_SETTERS.join("|")})$`);
/** Programs that take the NAME of a variable (or of an environment entry) to set, with no `=`. */
const NAMES_A_VARIABLE =
  /^(read|mapfile|readarray|getopts|launchctl|tmux|systemctl|defaults|setenv|for|select)$/;

/** Programs that only print or search what they are handed, so a switch's name in their arguments is text. */
const PRINTS_OR_SEARCHES = /^(rg|grep|egrep|fgrep|ag|ack|echo|printf|cat|head|tail|wc)$/;
/** What a print or search may be piped into without the text going anywhere: another filter. */
const FILTERS = /^(sort|uniq|cut|tr|nl|column)$/;
/** `git` subcommands whose arguments are text or a message: a search, a print, a commit message. */
const GIT_TEXT_ARGUMENTS = /^(log|grep|show|diff|commit)$/;

/** Options that make a search tool run the command line they are given. */
const EXECUTOR_OPTION =
  /^--(?:pre|hostname-bin|ackrc|open-files-in-pager)(?:=|$)|^--pag(?:e|er)?(?:=|$)/;
/** git takes any unambiguous prefix of a long option: `--open-files-in-p`. `--open` is the shortest. */
const isGitPagerOption = (arg: string): boolean => {
  if (arg.startsWith("-O")) return true;
  if (!arg.startsWith("--op")) return false;
  return spellsLong(longName(arg), "open-files-in-pager", 4);
};

/** The parts of a parsed command this rule reads. */
export interface SwitchCommand {
  readonly prog: string;
  readonly args: readonly string[];
  readonly assigns: readonly string[];
  readonly outs: readonly string[];
}

/** One command line segment and the operator that joined it to the one before. */
export interface SwitchPart {
  readonly text: string;
  readonly joiner: string;
}

/** git's subcommand and the arguments after it; the caller owns git's global-option grammar. */
export type GitSplitter = (args: readonly string[]) => { sub: string; rest: readonly string[] };

/** The script of a `sed` command line: every `-e`/`--expression` value, else the first operand (the rest are files). */
function sedScripts(args: readonly string[]): string[] {
  const explicit: string[] = [];
  let firstOperand: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a.startsWith("--expression=")) explicit.push(a.slice("--expression=".length));
    else if (a === "--expression" || /^-[A-Za-z]*e$/.test(a)) explicit.push(args[++k] ?? "");
    else if (!a.startsWith("-")) firstOperand ??= a;
  }
  if (explicit.length > 0) return explicit;
  return firstOperand === undefined ? [] : [firstOperand];
}

/** An `s` command up to its flags (`s/a/b/` leaves `s`), with whatever delimiter it uses. */
const SUBSTITUTE_COMMAND = /(^|[;{}\s])s([^\s\\\w])(?:\\.|(?!\2).)*\2(?:\\.|(?!\2).)*\2/g;
/** An address regex between slashes. */
const ADDRESS_REGEX = /\/(?:\\.|[^/\\])*\//g;

/** `sed` script text that may write a file or run a command: a `w`, `W` or `e` command, or an `s///w` flag. */
function sedMayWriteOrRun(args: readonly string[]): boolean {
  if (args.some((a) => /^-[A-Za-z]*f/.test(a) || a === "--file" || a.startsWith("--file=")))
    return true;
  // The patterns and replacements are text, whatever letters they hold; what is left are commands and flags.
  return sedScripts(args).some((script) =>
    /[wWe]/.test(script.replace(SUBSTITUTE_COMMAND, "$1s").replace(ADDRESS_REGEX, "")),
  );
}

/** Does this filter (a command a print may be piped into) write a file or run a command? */
function filterWrites(p: SwitchCommand): boolean {
  if (p.outs.length > 0) return true;
  if (p.prog === "sort") {
    return p.args.some(
      (a) =>
        /^-[A-Za-z]*o/.test(a) ||
        /^--(?:o|ou|out|outp|outpu|output|compress-program)(?:=|$)/.test(a),
    );
  }
  if (p.prog === "uniq") {
    let operands = 0;
    for (let k = 0; k < p.args.length; k++) {
      const a = p.args[k] ?? "";
      if (/^-[fsw]$/.test(a)) k++;
      else if (a === "-" || !a.startsWith("-")) operands++;
    }
    return operands > 1;
  }
  return false;
}

/** Does this command only print or search, with nothing assigned in front of it and nothing written or run by it? */
function printsOrSearches(p: SwitchCommand, git: GitSplitter): boolean {
  if (p.outs.some((out) => out !== "/dev/null") || p.assigns.length > 0) return false;
  if (p.args.some((a) => EXECUTOR_OPTION.test(a))) return false;
  if (PRINTS_OR_SEARCHES.test(p.prog)) return true;
  if (p.prog === "git") {
    const { sub, rest } = git(p.args);
    if (!GIT_TEXT_ARGUMENTS.test(sub)) return false;
    if (sub === "grep" && rest.some(isGitPagerOption)) return false;
    return !(sub === "commit" && rest.some((a) => a === "-t" || /^--templ/.test(a)));
  }
  // `sed -n '/NAME=/p'` prints; `sed -i`, `sed -n 'w f'` and a plain `sed s///` into a redirect write.
  if (p.prog !== "sed") return false;
  const quiet = p.args.some((a) => /^-[A-Za-z]*n/.test(a) || a === "--quiet" || a === "--silent");
  const inPlace = p.args.some((a) => /^-[A-Za-z]*i/.test(a) || isLongInPlace(a));
  return quiet && !inPlace && !sedMayWriteOrRun(p.args);
}

/** Does this command hand a harness variable to the shell or the session to set, as an assignment or by name? */
function assignsOrNames(p: SwitchCommand): boolean {
  // One reading of an assignment (`shell-assignments.ts`): `NAME=v`, `NAME+=v`, `${NAME:=v}` in any word, a name spelled
  // with quotes, backslashes, a comma group or a sequence (`CODEX_HOM{E..E}=x`).
  const assigned = (words: readonly string[]): boolean =>
    assignments(words).some((a) => GUARDED.has(a.name));
  if (assigned(p.assigns)) return true;
  if (assigned(p.args.filter(hasParameterAssignment))) return true;
  if (VARIABLE_SETTER.test(p.prog) && (assigned(p.args) || hasUnplaceableName(p.args))) return true;
  if (NAMES_A_VARIABLE.test(p.prog)) return namesGuarded(p.args);
  if (p.prog !== "printf") return false;
  const named = p.args.flatMap((a, k) =>
    a === "-v" ? [p.args[k + 1] ?? ""] : a.startsWith("-v") ? [a.slice(2)] : [],
  );
  return namesGuarded(named);
}

/** Is one of these words the NAME of a guarded variable (`read CODEX_HOME`), alone or with an assignment after it? */
const namesGuarded = (words: readonly string[]): boolean =>
  shellWords(words).some((w) => GUARDED.has(w.split(/[:+]?=/, 1)[0] ?? ""));

/**
 * Does one command line SWITCH the harness (see the module comment)? `git` splits the arguments of a git
 * command into subcommand and rest; `parts` and `parsed` run in step, one entry per simple command.
 */
export function switchesHarness(
  parts: readonly SwitchPart[],
  parsed: readonly SwitchCommand[],
  git: GitSplitter,
): boolean {
  return parts.some((part, i) => {
    const p = parsed[i] as SwitchCommand;
    if (assignsOrNames(p)) return true;
    const text = part.text;
    if (!SWITCH_TEXT.test(text) && !SWITCH_TEXT.test(text.replace(OBFUSCATION, ""))) return false;
    // The mention is harmless only when this command and every filter after it in the pipeline just print.
    if (!printsOrSearches(p, git)) return true;
    for (let j = i + 1; parts[j]?.joiner === "|"; j++) {
      const next = parsed[j] as SwitchCommand;
      if (!printsOrSearches(next, git) && !(FILTERS.test(next.prog) && !filterWrites(next)))
        return true;
    }
    return false;
  });
}
