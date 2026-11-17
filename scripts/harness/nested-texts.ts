/**
 * The command lines a simple command runs INSIDE itself, as texts to judge (wave 11 part C, C4, C5, C7; moved out of `patterns.ts`).
 * `bash -c 'CMD'`, `eval CMD`, a wrapper's string (`watch`, `su -c`, `ssh host CMD`, `rsync -e`, `script -c`), the command behind a container
 * image or name (`docker run|exec`, `compose run|exec`), and a command run in a container that mounts the repo: each is judged as a command
 * line of its own. A text is the text the SHELL would see: a re-quoted word has no backslash the readers keep (`wrappers.ts` `shellQuote`),
 * and the stdin the segment is fed (a here-string, a heredoc, a pipe from `echo`) is handed to the command that really reads it, so a
 * client's `\c host=H` is seen behind a `docker exec -i` (R8-CR-5). Pure.
 */
import { containerCommand, hiddenEnvFileReason } from "./container-run";
import { shellCommandStrings } from "./shell-command-string";
import { COMMAND_SHELLS } from "./shell-command-string";
import { withStdin } from "./stdin-texts";
import { containerRun, shellStrings } from "./wrappers";

export interface NestedText {
  /** The command line to judge. */
  readonly text: string;
  /** The directory it runs in, when a mount or `-w` says so (a host path). */
  readonly workdir?: string;
  /** A question the guard asks instead of guessing (a container option it cannot place), phrased as the words after "after `". */
  readonly unplaced?: string;
  /** A reason the guard asks outright (an env-file whose content it cannot see). */
  readonly asks?: string;
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
): NestedText[] {
  const out: NestedText[] = [];
  let stdin: readonly string[] | undefined;
  const add = (text: string, rest: Omit<NestedText, "text"> = {}): void => {
    if (text.trim() === "") return;
    stdin ??= stdinOf();
    out.push({ text: withStdin(text, stdin), ...rest });
  };
  if (prog === "eval") add(evalLine(args));
  else if (COMMAND_SHELLS.test(prog)) for (const text of shellCommandStrings(prog, args)) add(text);
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
