/**
 * What `xargs` is fed becomes part of the command it runs (wave 13 part A, A9: R10-ADV-A9). `echo 'CMD' | xargs -I{} sh -c '{}'` runs CMD, a print piped into
 * `xargs git commit -m x` or `xargs psql -h` hands the text to git or to psql as an option or a host, `echo .claude/settings.json | xargs rm` removes a protected
 * file; the stage after the pipe was judged as typed, with the text it is fed left out. The text a print hands over is known, so the command is written out with it
 * (BSD xargs, the one installed here, read: `-I REPL` replaces REPL in the arguments with each LINE, `-J REPL` with every item, and with neither the items are appended;
 * GNU's `-i[REPL]` and `--replace[=REPL]` are read the same way and unverified, no GNU xargs is installed). A text the guard cannot see (`find … | xargs -I{} sh -c '{}'`)
 * asks only where the replacement string STARTS the program word or a word of a shell, `ssh`, `eval`, a wrapper or a container command (the data is the command:
 * `sh -c '{}'`); `sh -c 'echo {}'` and an ordinary `find … | xargs rm` stay allowed. Pure.
 */
import { programName } from "./program-name";
import { joinedAndQuoted } from "./shell-quote";
import { peelWrapper } from "./wrapper-peel";

export interface XargsRuns {
  /** The command lines xargs makes of the known texts, one per invocation (the whole feed for the append form). */
  readonly lines: readonly string[];
  /** The replacement string stands where data is run, and the text is one the guard cannot see. */
  readonly question: boolean;
}

/** Programs that run one of their arguments as a command line or as another program. */
const RUNS_ARGUMENT =
  /^(?:sh|bash|zsh|dash|ksh|fish|csh|tcsh|ash|ssh|eval|env|sudo|doas|su|docker|podman|kubectl|nice|nohup|watch|timeout|time|exec|command)$/;

const NO_SPLIT = (): never => {
  throw new Error("xargs splits no string");
};

/** The replacement string and the kind of replacement an xargs option set asks for. */
function replacement(
  options: ReadonlyArray<{ readonly name: string; readonly value: string | undefined }>,
): { readonly token: string; readonly all: boolean } | null {
  const last = [...options].reverse().find((o) => ["I", "J", "i", "replace"].includes(o.name));
  if (last === undefined) return null;
  const token = last.value === undefined || last.value === "" ? "{}" : last.value;
  return { token, all: last.name === "J" };
}

/** The items of a text xargs reads without `-I`: blank separated (quotes are not read: an item with a quote is judged as typed). */
const itemsOf = (text: string): string[] => text.split(/\s+/).filter((item) => item !== "");

/**
 * The runs of the `xargs` command whose typed words are `typed` (after assignments), given the texts it is fed; null when the command is no xargs or runs no command of
 * its own.
 */
export function xargsRuns(
  typed: readonly string[],
  texts: readonly string[],
  unseen: boolean,
): XargsRuns | null {
  const at = typed.findIndex((w) => !/^[A-Za-z_]\w*\+?=/.test(w));
  if (at < 0 || !/^g?xargs$/.test(programName(typed[at] ?? ""))) return null;
  const peel = peelWrapper("xargs", typed, at, NO_SPLIT);
  if (peel === null || peel.stays) return null;
  const command = typed.slice(peel.next);
  if (command.length === 0) return null;
  const replace = replacement(peel.options);
  const lines: string[] = [];
  for (const text of texts) {
    if (replace === null) {
      lines.push(...joinedAndQuoted([...command, ...itemsOf(text)]).slice(-1));
      continue;
    }
    const inputs = replace.all ? [itemsOf(text).join(" ")] : text.split("\n");
    for (const input of inputs.map((line) => line.trim()).filter((line) => line !== "")) {
      const argv = command.map((word) => word.split(replace.token).join(input));
      lines.push(...joinedAndQuoted(argv).slice(-1));
    }
  }
  const program = programName(command[0] ?? "");
  const dataIsRun =
    replace !== null &&
    (command[0]?.includes(replace.token) === true ||
      (RUNS_ARGUMENT.test(program) && command.slice(1).some((w) => w.startsWith(replace.token))));
  return { lines, question: dataIsRun && (unseen || texts.length === 0) };
}
