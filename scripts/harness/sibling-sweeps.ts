/**
 * Siblings of the whole-tree sweeps the classifier already asks about (round-5 ADV5-3). `grep -r`, `rg -u`, `find …
 * -exec cat`, `cp -r` and `tar c` over the repo root read or copy every live env file under it, and each has a
 * sibling the table did not know: `ack` (recursive, reads no .gitignore), `ag -u`, `fd -x`, `find … | cpio -p`, `pax
 * -rw`. Each is rewritten here into the command line it is the sibling of; the classifier judges that line with the
 * machinery it has (operand placement, narrowing by a safe `-name`, writes onto protected paths) instead of a second
 * copy of it. A text heuristic for a cooperative agent: the names a command reads from standard input (`cpio`, `pax`)
 * are known only when a `find` feeds them in the same pipeline. Pure.
 */
import { shellQuote } from "./wrappers";

/** The command before this one in its pipeline: only a `find` says which tree reaches a standard-input reader. */
export interface Feeder {
  readonly prog: string;
  readonly args: readonly string[];
}

/** One command line to judge in place of the sibling, and what the sibling is judged as (for the reason). */
export interface SiblingCommand {
  readonly text: string;
  readonly label: string;
}

const quoted = (words: readonly string[]): string => words.map(shellQuote).join(" ");
const isOption = (a: string): boolean => a.startsWith("-");
/** `--version`, `--help` and the like: nothing is searched. */
const INFORMATION = /^(?:-V|--help|--version|--man|--help-types)$/;

/** The start operands of the `find` that feeds a reader: the words before its first expression. Default: `.`. */
function findStarts(feeder: Feeder | null): string[] | null {
  if (feeder?.prog !== "find") return null;
  let k = 0;
  while (/^-[HLP]$/.test(feeder.args[k] ?? "")) k++;
  const starts: string[] = [];
  for (; k < feeder.args.length && !/^(-|\\?\(|!)/.test(feeder.args[k] ?? ""); k++) {
    starts.push(feeder.args[k] as string);
  }
  return starts.length > 0 ? starts : ["."];
}

// ---------------------------------------------------------------------------------------------------------
// ack and ag: recursive searches that go around .gitignore
// ---------------------------------------------------------------------------------------------------------

/** `ag` skips gitignored and hidden files unless one of these stops it (as `rg -u` / `--hidden` / `--no-ignore`). */
const AG_NO_IGNORE = /^(?:-[A-Za-z]*[uU][A-Za-z]*|--unrestricted|--skip-vcs-ignores|--hidden)$/;

function searchSibling(prog: string, args: readonly string[]): SiblingCommand[] {
  if (args.some((a) => INFORMATION.test(a))) return [];
  if (!args.some((a) => !isOption(a))) return []; // no pattern: nothing is searched
  if (prog === "ack") {
    // `ack -f` and `-g` list file names; the rest searches every text file, .gitignore or not.
    if (args.some((a) => a === "-f" || a === "-g")) return [];
    return [{ text: `grep -r ${quoted(args)}`, label: "grep -r" }];
  }
  if (!args.some((a) => AG_NO_IGNORE.test(a))) return [];
  return [{ text: `rg -u ${quoted(args)}`, label: "rg -u" }];
}

// ---------------------------------------------------------------------------------------------------------
// fd -x / -X: find -exec
// ---------------------------------------------------------------------------------------------------------

const FD_VALUE_SHORT = /^-[dEteSocjC]$/;
const FD_VALUE_LONG =
  /^--(?:and|max-depth|min-depth|exact-depth|exclude|type|extension|size|changed-within|changed-before|owner|format|batch-size|ignore-file|color|ignore-contain|threads|max-results|base-directory|path-separator|search-path)$/;
const SAFE_EXTENSION =
  /^(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|sql|ya?ml|css|html|py|sh|toml|txt|rs|go)$/i;
/** `{}`, `{/}`, `{.}`, `{//}`, `{/.}`: where fd puts the file; without one it appends the file as the last word. */
const FD_PLACEHOLDER = /\{(?:\/|\.|\/\/|\/\.)?\}/;

interface FdParts {
  readonly paths: string[];
  readonly extensions: string[];
  readonly command: string[];
  readonly batch: boolean;
}

/** `fd [options] [pattern] [path…] -x cmd …`: the search paths, the `-e` extensions and the command run on each file. */
function fdParts(args: readonly string[]): FdParts | null {
  const positional: string[] = [];
  const extensions: string[] = [];
  const searchPaths: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "-x" || a === "--exec" || a === "-X" || a === "--exec-batch") {
      // fd takes every word after `-x`/`-X` as the command (up to a lone `;`).
      const end = args.indexOf(";", k + 1);
      const command = args.slice(k + 1, end < 0 ? undefined : end);
      if (command.length === 0) return null;
      const paths = searchPaths.length > 0 ? searchPaths : positional.slice(1);
      return { paths, extensions, command, batch: a === "-X" || a === "--exec-batch" };
    }
    if (a === "-e" || a === "--extension") extensions.push(args[++k] ?? "");
    else if (a.startsWith("--extension=")) extensions.push(a.slice("--extension=".length));
    else if (a === "--search-path") searchPaths.push(args[++k] ?? "");
    else if (a.startsWith("--search-path=")) searchPaths.push(a.slice("--search-path=".length));
    else if (FD_VALUE_SHORT.test(a) || FD_VALUE_LONG.test(a)) k++;
    else if (!isOption(a)) positional.push(a);
  }
  return null; // no -x or -X: fd only lists names
}

function fdSibling(args: readonly string[]): SiblingCommand[] {
  const parts = fdParts(args);
  if (parts === null) return [];
  const withFile = parts.command.some((w) => FD_PLACEHOLDER.test(w))
    ? parts.command
    : [...parts.command, "{}"];
  // Narrowed by extension only when EVERY extension is a source type; one `env` would reopen the whole tree.
  const narrowed =
    parts.extensions.length > 0 && parts.extensions.every((e) => SAFE_EXTENSION.test(e));
  const text = [
    "find",
    parts.paths.length > 0 ? quoted(parts.paths) : ".",
    narrowed ? quoted(["-name", `*.${parts.extensions[0]}`]) : "", // one source type is enough: all are
    "-exec",
    quoted(withFile),
    parts.batch ? "+" : "\\;",
  ]
    .filter((word) => word !== "")
    .join(" ");
  return [{ text, label: "find -exec" }];
}

// ---------------------------------------------------------------------------------------------------------
// cpio -p / -o and pax -rw / -w: copy-out and archive
// ---------------------------------------------------------------------------------------------------------

const CPIO_VALUE_SHORT = /^-[OIFHCERD]$/;
const PAX_VALUE_SHORT = /^-[spfbxUGTo]$/;

/** The words that are not options, skipping the values of the options in `valued`. */
function operandsOf(args: readonly string[], valued: RegExp): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "--") return [...out, ...args.slice(k + 1)];
    if (valued.test(a)) k++;
    else if (!isOption(a)) out.push(a);
  }
  return out;
}

const hasLetter = (args: readonly string[], letter: string, long: string): boolean =>
  args.some((a) => a === long || (/^-[A-Za-z0-9]+$/.test(a) && a.includes(letter)));

const copyOut = (sources: readonly string[], dest: string): SiblingCommand => ({
  text: `cp -r ${quoted([...sources, dest])}`,
  label: "cp -r",
});
const archive = (sources: readonly string[]): SiblingCommand => ({
  text: `tar -c ${quoted(sources)}`,
  label: "tar c",
});

function cpioSibling(args: readonly string[], feeder: Feeder | null): SiblingCommand[] {
  const starts = findStarts(feeder);
  if (starts === null) return []; // the names come from a list the guard cannot see
  if (hasLetter(args, "p", "--pass-through")) {
    const dest = operandsOf(args, CPIO_VALUE_SHORT)[0];
    return dest === undefined ? [] : [copyOut(starts, dest)];
  }
  return hasLetter(args, "o", "--create") ? [archive(starts)] : [];
}

function paxSibling(args: readonly string[], feeder: Feeder | null): SiblingCommand[] {
  const reads = hasLetter(args, "r", "--read");
  const writes = hasLetter(args, "w", "--write");
  if (!writes) return [];
  const operands = operandsOf(args, PAX_VALUE_SHORT);
  if (!reads) {
    const sources = operands.length > 0 ? operands : findStarts(feeder);
    return sources === null || sources.length === 0 ? [] : [archive(sources)];
  }
  // `pax -rw [SRC…] DEST`: the last operand is the destination directory.
  const dest = operands.at(-1);
  if (dest === undefined) return [];
  const sources = operands.length > 1 ? operands.slice(0, -1) : findStarts(feeder);
  return sources === null ? [] : [copyOut(sources, dest)];
}

/**
 * The command lines to judge in place of `prog args`, when it is a sibling of a tree sweep and reaches the tree: `ack`
 * as `grep -r`, `ag` with an ignore-disabling flag as `rg -u`, `fd -x`/`-X` as `find -exec`, `cpio -p`/`-o` and
 * `pax -rw`/`-w` as `cp -r` and `tar c` over the tree a `find` feeds them. None for anything else.
 */
export function siblingCommands(
  prog: string,
  args: readonly string[],
  feeder: Feeder | null,
): SiblingCommand[] {
  if (prog === "ack" || prog === "ag") return searchSibling(prog, args);
  if (prog === "fd") return fdSibling(args);
  if (prog === "cpio") return cpioSibling(args, feeder);
  if (prog === "pax") return paxSibling(args, feeder);
  return [];
}
