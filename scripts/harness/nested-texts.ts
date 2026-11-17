import { words } from "./command-words";
/**
 * The command lines a simple command runs INSIDE itself, as texts to judge (wave 11 part C, C4, C5, C7; moved out of `patterns.ts`).
 * `bash -c 'CMD'`, `eval CMD`, a wrapper's string (`watch`, `su -c`, `ssh host CMD`, `rsync -e`, `script -c`), the command behind a container
 * image or name (`docker run|exec`, `compose run|exec`), and a command run in a container that mounts the repo: each is judged as a command
 * line of its own. A text is the text the SHELL would see: a re-quoted word has no backslash the readers keep (`wrappers.ts` `shellQuote`),
 * and the stdin the segment is fed (a here-string, a heredoc, what every earlier stage prints or carries, a process substitution, a known variable, a
 * group's redirect: `stdin-texts.ts`) is handed to the command that really reads it, so a client's `\c host=H` is seen behind a `docker exec -i`
 * (R8-CR-5, R9-CR-3). Pure.
 */
import { containerCommand, hiddenEnvFileReason } from "./container-run";
import { expandVariables } from "./db-variables";
import { printedText } from "./inline-code";
import { COMMAND_SHELLS, shellCommandStrings } from "./shell-command-string";
import { UNVERIFIED_SHELLS } from "./shell-grammars";
import { withStdin } from "./stdin-texts";
import { containerRun, shellStrings } from "./wrappers";

export interface NestedText {
  /** The command line to judge. */
  readonly text: string;
  /** The directory it runs in, when a mount or `-w` says so (a host path). */
  readonly workdir?: string;
  /** A question the guard asks instead of guessing (a container option it cannot place), phrased as the words after "after `". */
  readonly unplaced?: string;
  /** A question with its whole reason (a shell string the guard cannot read): asked as it stands. */
  readonly question?: string;
  /** A reason the guard asks outright (an env-file whose content it cannot see). */
  readonly asks?: string;
}

/** The reason a shell string the guard cannot read asks (R9-ADV-12). */
export const SHELL_STRING_QUESTION =
  'A shell is handed a command string the guard cannot read: a variable no statement of the command sets, a positional parameter or a command substitution (`bash -c "$C"`, `sh -c "$(…)"`). Put the command in the string itself, or let a human decide.';

/** The reason a `-c` of a shell no table was recorded for asks (wave 12, E1-1: where a shell is not installed, its `-c` asks). */
export const UNVERIFIED_SHELL_QUESTION =
  "This shell is not installed where the guard's shell tables were recorded (`fish`, `pwsh`, `powershell`, `ash`), so how it reads its own options is unverified: its command string is judged, and a human decides.";

/** A string that is one expansion and nothing else: `$C`, `${C}`, `$1`, `$@`. */
const LONE_EXPANSION = /^\$(?:\{[^{}]+\}|[A-Za-z_]\w*|[0-9@*#?!$-])$/;
/** A string that is one command substitution: `$(echo CMD)`, a backtick pair. */
const LONE_SUBSTITUTION = /^(?:\$\(([^()]*)\)|`([^`]*)`)$/;

/** What `echo` or `printf` inside a substitution prints, when that is plain text (no expansion of its own). */
function printedBySubstitution(inner: string): string | null {
  const [prog, ...rest] = words(inner.trim());
  const printed = prog === undefined ? null : printedText(prog, rest);
  return printed !== null && !/[$`]/.test(printed) ? printed : null;
}

/**
 * The readings of the string a shell is given as its command. A string that is one variable (`C='CMD'; bash -c "$C"`) is each value a statement of
 * the command gives it; one that no statement places, a positional parameter, and a command substitution that is no plain `echo` are questions; a
 * substitution that is a plain `echo CMD` is CMD. Any other string is itself (R9-ADV-12).
 */
function shellStringReadings(
  text: string,
  variables: () => ReadonlyMap<string, readonly string[]>,
): { readonly texts: readonly string[]; readonly question: boolean } {
  if (LONE_EXPANSION.test(text)) {
    const read = expandVariables(text, variables());
    const placed = read.texts.filter((t) => t !== text && t.trim() !== "");
    return { texts: placed, question: read.unplaceable || placed.length === 0 };
  }
  const substitution = LONE_SUBSTITUTION.exec(text);
  if (substitution === null) return { texts: [text], question: false };
  const printed = printedBySubstitution(substitution[1] ?? substitution[2] ?? "");
  return { texts: printed === null ? [] : [printed], question: printed === null };
}

/** `eval -- CMD`: the arguments are the command line; a leading `--` ends eval's options. */
const evalLine = (args: readonly string[]): string =>
  (args[0] === "--" ? args.slice(1) : args).join(" ");

/**
 * The texts the command `prog args` runs inside itself. `stdinOf` reads what the segment is fed (asked for only when there is a text to carry it
 * to); it is carried to the command line whose stdin it is.
 * `find -exec` and the git strings are judged by the classifier itself.
 */
export function nestedTexts(
  prog: string,
  args: readonly string[],
  stdinOf: () => readonly string[],
  isLocalHost: (host: string) => boolean,
  variables: () => ReadonlyMap<string, readonly string[]> = () => new Map(),
): NestedText[] {
  const out: NestedText[] = [];
  let stdin: readonly string[] | undefined;
  const add = (text: string, rest: Omit<NestedText, "text"> = {}): void => {
    if (text.trim() === "") return;
    stdin ??= stdinOf();
    out.push({ text: withStdin(text, stdin), ...rest });
  };
  if (prog === "eval") add(evalLine(args));
  else if (COMMAND_SHELLS.test(prog)) {
    const strings = shellCommandStrings(prog, args);
    if (strings.length > 0 && UNVERIFIED_SHELLS.includes(prog)) {
      out.push({ text: "", question: UNVERIFIED_SHELL_QUESTION });
    }
    for (const text of strings) {
      const read = shellStringReadings(text, variables);
      for (const reading of read.texts) add(reading);
      if (read.question) out.push({ text: "", question: SHELL_STRING_QUESTION });
    }
  }
  // A command line a wrapper hands to a shell (`watch 'x'`, `su -c 'x'`, `ssh h 'x'`, `rsync -e 'x'`).
  for (const text of shellStrings(prog, args, isLocalHost)) add(text);
  // A command run in a fresh container or in a running one (`docker run IMG psql -h HOST`, `docker exec -e PGHOST=H db psql`): its paths
  // are the container's, but a client, a push or a secret read is the same wherever it runs.
  const behind = containerCommand(prog, args);
  if (behind !== null) {
    add(behind.command, {
      ...(behind.unplaced === undefined
        ? {}
        : { unplaced: `${prog} ${behind.verb} ${behind.unplaced}` }),
      ...(behind.hiddenEnvFile === undefined ? {} : { asks: hiddenEnvFileReason(prog, behind) }),
    });
    // An env-file the guard cannot see sets variables even for the image's own command: the ask stands without a command behind it.
    if (behind.command === "" && behind.hiddenEnvFile !== undefined) {
      out.push({ text: "", asks: hiddenEnvFileReason(prog, behind) });
    }
  }
  // A command run in a container that mounts the repo: its paths read as the host's.
  const mounted = containerRun(prog, args);
  if (mounted !== null)
    add(mounted.command, mounted.workdir === undefined ? {} : { workdir: mounted.workdir });
  return out;
}
