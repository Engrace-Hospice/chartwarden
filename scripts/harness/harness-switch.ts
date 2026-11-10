/**
 * The harness-switch rule: does one command line switch off, or re-point, part of the agent harness?
 * Moved out of `patterns.ts` unchanged; pure, so it imports nothing from the classifier.
 */

/**
 * Variables that disable or redirect an agent guard, its ledger, or the tree whose controls it judges. `HOME`
 * moves what `~` and `$HOME` mean, so `HOME=<the repo> sh -c 'echo x > ~/scripts/harness/p'` writes into it.
 */
const HARNESS_SWITCH_NAMES =
  "CW_STOP_GATE|CW_AGENT_LEDGER|CW_HARNESS_FAIL_OPEN|CW_HARNESS_ROOT_FOR_TESTS|ECC_DISABLED_HOOKS|ECC_GATEGUARD|CODEX_HOME|CLAUDE_CONFIG_DIR|CLAUDE_PROJECT_DIR|HOME";
/** A shell word that assigns one: `NAME=value`. */
const HARNESS_SWITCH = new RegExp(`^(${HARNESS_SWITCH_NAMES})=`);
/** The name and `=` ANYWHERE in a command's text, quotes and nested strings included (`ssh h 'NAME=x cmd'`). */
const HARNESS_SWITCH_TEXT = new RegExp(`\\b(${HARNESS_SWITCH_NAMES})=`);
/** Programs whose own arguments assign variables (`export NAME=value`, `env NAME=value cmd`). */
const VARIABLE_SETTER = /^(export|declare|typeset|readonly|local|env)$/;
/** Programs that only print or search what they are handed, so a switch's name in their arguments is text. */
const PRINTS_OR_SEARCHES = /^(rg|grep|egrep|fgrep|ag|ack|echo|printf|cat|less|head|tail|wc)$/;
/** What a print or search may be piped into without the text going anywhere: another filter. */
const FILTERS = /^(sort|uniq|cut|tr|nl|column)$/;
/** `git` subcommands whose arguments are text or a message: a search, a print, a commit message. */
const GIT_TEXT_ARGUMENTS = /^(log|grep|show|diff|commit)$/;

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

/** What the rule needs from the classifier: git's subcommand, and whether a `sed` argument is in-place or `-n`. */
export interface SwitchHelpers {
  readonly gitSubcommand: (args: readonly string[]) => string;
  readonly clusterHas: (arg: string, letters: string) => boolean;
  readonly isInPlace: (arg: string) => boolean;
}

/** Does this command only print or search, with nothing assigned in front of it and nothing written by it? */
function printsOrSearches(p: SwitchCommand, h: SwitchHelpers): boolean {
  if (p.outs.some((out) => out !== "/dev/null") || p.assigns.length > 0) return false;
  if (PRINTS_OR_SEARCHES.test(p.prog)) return true;
  if (p.prog === "git") return GIT_TEXT_ARGUMENTS.test(h.gitSubcommand(p.args));
  // `sed -n '/NAME=/p'` prints; `sed -i` and a plain `sed s///` into a redirect are writers handled elsewhere.
  return p.prog === "sed" && p.args.some((a) => h.clusterHas(a, "n")) && !p.args.some(h.isInPlace);
}

/**
 * Does one command line SWITCH the harness: assign a harness variable as a `NAME=value` prefix (also behind
 * `sudo`, `env`, `time`…) or as an argument of `export`/`declare`/`env`, or carry the name and `=` anywhere in its
 * text (inside `$( )`, `ssh h '…'`, `script -c '…'`, `watch '…'`, `xargs`, a value an assignment builds)? Only a
 * command that prints or searches, and whose output goes nowhere but a filter, may MENTION the name
 * (`rg CODEX_HOME= docs`, `echo CODEX_HOME=x`): that text sets nothing. A `NAME` with no `=` sets nothing either.
 */
export function switchesHarness(
  parts: readonly SwitchPart[],
  parsed: readonly SwitchCommand[],
  h: SwitchHelpers,
): boolean {
  return parts.some((part, i) => {
    const p = parsed[i] as SwitchCommand;
    const words = [...p.assigns, ...(VARIABLE_SETTER.test(p.prog) ? p.args : [])];
    if (words.some((w) => HARNESS_SWITCH.test(w))) return true;
    if (!HARNESS_SWITCH_TEXT.test(part.text)) return false;
    // The mention is harmless only when this command and every filter after it in the pipeline just print.
    if (!printsOrSearches(p, h)) return true;
    for (let j = i + 1; parts[j]?.joiner === "|"; j++) {
      const next = parsed[j] as SwitchCommand;
      if (!printsOrSearches(next, h) && !(FILTERS.test(next.prog) && next.outs.length === 0))
        return true;
    }
    return false;
  });
}
