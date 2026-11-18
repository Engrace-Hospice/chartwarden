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

/**
 * What `find … -exec PROG {}` can run on every file besides a reader: an archiver or a copier carries each file's content out
 * (`-exec tar rf /tmp/o.tar {} +`, `-exec cp {} /tmp/x ;`). Over a tree that holds a live env file each asks, like `-exec cat`
 * (wave 10, B12). A shell (`-exec sh -c 'cat "$1"' _ {} ;`) is one when the string it runs holds one of these or a reader.
 */
export const EXEC_SWEEP_READER =
  /^(?:tar|zip|7z|7za|7zr|7zz|cpio|pax|rsync|cp|scp|ditto|gzip|bzip2|xz|zstd|openssl)$/;
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
const AG_NO_IGNORE =
  /^(?:-[A-Za-z]*[uUa][A-Za-z]*|--unrestricted|--skip-vcs-ignores|--hidden|--all-types)$/;

/** `ugrep` and `zgrep` search a tree only when told (`-r`, `-R`, `--recursive`); `rga`, `pt`, `sift` and `ucg` search one by default. */
const RECURSIVE_FLAG = /^(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive|--dereference-recursive)$/;
const SEARCHES_TREE_BY_DEFAULT: ReadonlySet<string> = new Set(["rga", "pt", "sift", "ucg"]);

/** `gitleaks detect --no-git --source DIR`, `gitleaks dir DIR`, `trufflehog filesystem DIR`: every file under DIR is read. */
function secretScannerSibling(prog: string, args: readonly string[]): SiblingCommand[] {
  // `gitleaks … --redact` masks the secrets it finds (the repo's own pre-commit hook); a scan of git history reads no working file.
  if (args.some((a) => a === "--redact" || a.startsWith("--redact="))) return [];
  const scansFiles =
    prog === "trufflehog"
      ? args.includes("filesystem")
      : args.includes("--no-git") || args.includes("dir") || args.includes("directory");
  if (!scansFiles) return [];
  const sources = args.flatMap((a, k) =>
    a === "--source" || a === "-s"
      ? [args[k + 1] ?? "."]
      : a.startsWith("--source=")
        ? [a.slice("--source=".length)]
        : [],
  );
  const positional = args.filter(
    (a) =>
      !isOption(a) && !["dir", "directory", "filesystem", "detect", "protect", "git"].includes(a),
  );
  const roots = sources.length > 0 ? sources : positional.length > 0 ? positional : ["."];
  return [{ text: `grep -r secret ${quoted(roots)}`, label: "grep -r" }];
}

/** `scp -r SRC… DEST`: the local sources are copied out. Remote specs (`host:path`) name another machine's files. */
function scpSibling(args: readonly string[]): SiblingCommand[] {
  if (!args.some((a) => /^-[A-Za-z]*r[A-Za-z]*$/.test(a))) return [];
  const operands = operandsOf(args, /^-[PiFcloJSoD]$/).map(localOperand);
  const sources = operands.slice(0, -1).filter((w) => w !== null) as string[];
  return sources.length === 0
    ? []
    : [{ text: `cp -r ${quoted([...sources, "/dev/null"])}`, label: "cp -r" }];
}

/** `host:path` is another machine's file, except `localhost:path`; any other word is a local path. */
const localOperand = (w: string): string | null => {
  const local = /^(?:[^@/:]+@)?(?:localhost|127\.0\.0\.1|\[::1\]):(.*)$/s.exec(w)?.[1];
  if (local !== undefined) return local.startsWith("/") ? local : `~/${local}`;
  return /^[^/]*:/.test(w) ? null : w;
};

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

/** What a short cluster (`-Hx`, `-HIx`, `-xcat`, `-He`) holds: the exec letter with its attached text, or a letter that takes a value. */
function fdCluster(a: string): { exec?: "x" | "X"; valued?: string; attached: string } | null {
  if (a.startsWith("--") || !/^-[A-Za-z]/.test(a)) return null;
  for (let p = 1; p < a.length; p++) {
    const letter = a[p] as string;
    if (letter === "x" || letter === "X") return { exec: letter, attached: a.slice(p + 1) };
    if (/[dEteSocjC]/.test(letter)) return { valued: letter, attached: a.slice(p + 1) };
  }
  return null;
}

/** `fd [options] [pattern] [path…] -x cmd …`: the search paths, the `-e` extensions and the command run on each file. */
function fdParts(args: readonly string[]): FdParts | null {
  const positional: string[] = [];
  const extensions: string[] = [];
  const searchPaths: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    const cluster = fdCluster(a);
    const long = /^--(exec|exec-batch)(?:=(.*))?$/s.exec(a);
    const exec = cluster?.exec ?? (long ? (long[1] === "exec" ? "x" : "X") : null);
    if (exec !== null) {
      // fd takes every word after `-x`/`-X` as the command (up to a lone `;`); `-xcat` and `--exec=cat` carry its first word.
      const first = cluster?.exec ? cluster.attached : (long?.[2] ?? "");
      const end = args.indexOf(";", k + 1);
      const command = [
        ...(first === "" ? [] : [first]),
        ...args.slice(k + 1, end < 0 ? undefined : end),
      ];
      if (command.length === 0) return null;
      const paths = searchPaths.length > 0 ? searchPaths : positional.slice(1);
      return { paths, extensions, command, batch: exec === "X" };
    }
    if (cluster?.valued === "e")
      extensions.push(cluster.attached !== "" ? cluster.attached : (args[++k] ?? ""));
    else if (cluster?.valued !== undefined) k += cluster.attached === "" ? 1 : 0;
    else if (a === "-e" || a === "--extension") extensions.push(args[++k] ?? "");
    else if (a.startsWith("--extension=")) extensions.push(a.slice("--extension=".length));
    else if (a === "--search-path") searchPaths.push(args[++k] ?? "");
    else if (a.startsWith("--search-path=")) searchPaths.push(a.slice("--search-path=".length));
    else if (FD_VALUE_LONG.test(a)) k++;
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

/** The names a here-string or an `echo`/`printf` before the reader hands it (`cpio -p dest <<< .`, `echo . | cpio -p dest`). */
function namedInput(feeder: Feeder | null, hereStrings: readonly string[]): string[] | null {
  if (feeder?.prog === "echo" || feeder?.prog === "printf") {
    const words = feeder.args.filter((a) => !isOption(a));
    if (words.length > 0) return words;
  }
  const words = hereStrings.flatMap((text) => text.split(/\s+/).filter((w) => w !== ""));
  return words.length > 0 ? words : null;
}

function cpioSibling(
  args: readonly string[],
  feeder: Feeder | null,
  hereStrings: readonly string[],
): SiblingCommand[] {
  // The names come from a `find`, an `echo` or a here-string; a list the guard cannot see (a file, another command) is unread.
  const starts = findStarts(feeder) ?? namedInput(feeder, hereStrings);
  if (starts === null) return [];
  if (hasLetter(args, "p", "--pass-through")) {
    const dest = operandsOf(args, CPIO_VALUE_SHORT)[0];
    return dest === undefined ? [] : [copyOut(starts, dest)];
  }
  return hasLetter(args, "o", "--create") ? [archive(starts)] : [];
}

// ---------------------------------------------------------------------------------------------------------
// 7z a and hdiutil create -srcfolder: archive a tree
// ---------------------------------------------------------------------------------------------------------

const SEVEN_ZIP = /^(?:7z|7za|7zr|7zz|7zip|p7zip)$/;
/** `7z a ARCHIVE SRC…`: the command word, then the archive, then the sources; its options (`-mx=9`, `-pSECRET`, `-r`) carry their own values. */
function sevenZipSibling(args: readonly string[]): SiblingCommand[] {
  const operands = args.filter((a) => !isOption(a));
  if (!/^(?:a|u)$/.test(operands[0] ?? "")) return [];
  const sources = operands.slice(2);
  return sources.length === 0 ? [] : [archive(sources)];
}

/** `hdiutil create -srcfolder DIR OUT`: an image of every file under DIR (`-srcdir` is the same). */
function hdiutilSibling(args: readonly string[]): SiblingCommand[] {
  if (args[0] !== "create") return [];
  const sources = args.flatMap((a, k) =>
    /^-(?:srcfolder|srcdir)$/.test(a) ? [args[k + 1] ?? "."] : [],
  );
  return sources.length === 0 ? [] : [archive(sources)];
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
 * `pax -rw`/`-w` as `cp -r` and `tar c` over the tree a `find` (or an `echo`, or a here-string: `cpio -pdm D <<< .`) feeds them,
 * and `7z a` and `hdiutil create -srcfolder` as `tar c` of their sources. None for anything else.
 */
export function siblingCommands(
  prog: string,
  args: readonly string[],
  feeder: Feeder | null,
  hereStrings: readonly string[] = [],
): SiblingCommand[] {
  if (prog === "ack" || prog === "ag") return searchSibling(prog, args);
  if ((prog === "ugrep" || prog === "zgrep") && args.some((a) => RECURSIVE_FLAG.test(a))) {
    return [{ text: `grep -r ${quoted(args)}`, label: "grep -r" }];
  }
  if (SEARCHES_TREE_BY_DEFAULT.has(prog) && args.some((a) => !isOption(a))) {
    return [{ text: `grep -r ${quoted(args)}`, label: "grep -r" }];
  }
  if (prog === "gitleaks" || prog === "trufflehog") return secretScannerSibling(prog, args);
  if (prog === "semgrep" && args.includes("--no-git-ignore")) {
    return [
      {
        text: `grep -r ${quoted(args.filter((a) => !isOption(a)).length > 0 ? ["x", ...args.filter((a) => !isOption(a))] : ["x"])}`,
        label: "grep -r",
      },
    ];
  }
  if (prog === "scp") return scpSibling(args);
  if (prog === "fd") return fdSibling(args);
  if (prog === "cpio") return cpioSibling(args, feeder, hereStrings);
  if (SEVEN_ZIP.test(prog)) return sevenZipSibling(args);
  if (prog === "hdiutil") return hdiutilSibling(args);
  if (prog === "pax") return paxSibling(args, feeder);
  return [];
}
