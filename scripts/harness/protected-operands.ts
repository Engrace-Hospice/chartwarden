/**
 * The generic backstop for writers the classifier has no model for (round-5 ADV5-2, rewritten in wave 8, T2: CR6-1,
 * ADV6-2, CR6-4, ADV6-5). Five review rounds each found another program that writes to a path the agent names
 * (`bun build --outfile`, `uniq IN OUT`, `ssh -E`, `plutil -replace`, `awk '… > ARGV[1]'`, `tree -o`, …), and a table of
 * writers can never be complete. So a command that NAMES a protected path as an argument of a program that is not known to
 * only read asks (`unmodelledWriterVerdict` in the classifier). Three kinds of program:
 *
 *   - READERS: programs that only read what they are handed (`cat`, `grep`, `ls`, `cloc`, `shfmt -d`). Exempt, unless the
 *     command line carries one of the program's WRITE FLAGS (`tree -o`, `awk '… > FILE'`, `plutil -replace`,
 *     `docker build -o`, `node --redirect-warnings=`): then the program is treated like an unknown one. The flags are data
 *     next to the name, with an example each, so the consistency test proves every entry in both directions.
 *   - MODELLED: programs whose writes `writers*.ts` and `patterns.ts` model by name (`cp`, `rm`, `tee`, `git`, `curl`,
 *     `tar`). The model judges the files they write, and their positional operands are the files they read, write or take
 *     as a source (`cp scripts/harness/x.ts /tmp/y` reads), so those are exempt; a protected path attached to an option
 *     (`--out=P`, `-o=P`, `key=P`) is not, unless the model read that option (its hit has already asked).
 *   - everything else: any word that is a protected path asks, positional or not.
 *
 * The words that count are the ones a program could open as a path: every word that is not an option, the value of
 * `--option=value`, `key=value` and an attached short option, and, for a program that is neither a reader nor modelled, the
 * names inside a word that has whitespace (an inline program, an editor command, a SQL string: ADV6-5).
 *
 * A limit, not a boundary: a computed name (`$VAR/x`, `$(printf …)`), an encoded name and a path a script builds stay
 * unseen. The sandbox is the real boundary. Pure.
 */

type FlagTest = (args: readonly string[]) => boolean;

/** What makes a program that normally only reads write a file its command line names, with an example that does. */
export interface WriteFlags {
  readonly test: FlagTest;
  readonly example: readonly string[];
}

/** An option spelled exactly, with its value joined by `=` or in the next word (`-o`, `--output`, `--output=F`). */
const opt =
  (...names: string[]): FlagTest =>
  (args) =>
    args.some((a) => names.some((n) => a === n || a.startsWith(`${n}=`)));
/** A short option letter alone, in a cluster, or with its value attached (`-o`, `-vo`, `-ofile`). */
const letter =
  (letters: string): FlagTest =>
  (args) =>
    args.some(
      (a) =>
        /^-[A-Za-z]/.test(a) && [...letters].some((l) => a.slice(1).split("=")[0]?.includes(l)),
    );
/** A word that is itself a subcommand or a verb (`cp`, `build`, `-replace`). */
const word =
  (...words: string[]): FlagTest =>
  (args) =>
    args.some((a) => words.includes(a));
const anyOf =
  (...tests: FlagTest[]): FlagTest =>
  (args) =>
    tests.some((t) => t(args));
const writes = (test: FlagTest, ...example: string[]): WriteFlags => ({ test, example });

/** awk writes with `print > FILE`, `print | "cmd"`, `system(…)`, `-i inplace` / `--include`, and a program file (`-f`) it cannot read. */
const AWK_WRITE = /\bprintf?\b[^;}()]*>|\bprintf?\b[^;}]*\|\s*\S|\bsystem\s*\(|inplace/;
/** The text of an awk program with its string literals emptied, so `printf "{}" > F` reads as a redirect. */
const withoutStrings = (text: string): string => text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
const awkWrites: FlagTest = (args) =>
  args.some(
    (a) =>
      AWK_WRITE.test(withoutStrings(a)) || a === "-f" || /^-i.+|^-i$|^--include(?:=|$)/.test(a),
  );

/**
 * GNU sed's `e` command (and the `e` flag of `s`) runs a command; BSD sed has neither. The script is read command by command
 * (`[address]command`), so a `;` inside the text of an `s` or an `a` is not a command separator. Its `w` and `W` are
 * modelled by name.
 */
const SED_ADDRESS =
  /^(?:\d+|\$|\/(?:[^/\\]|\\.)*\/)(?:\s*,\s*(?:\d+|\$|\/(?:[^/\\]|\\.)*\/))?\s*!?\s*/;
/** The index just after the third unescaped `delimiter` of an `s` or `y` command that starts at `from`, or -1. */
function sedSections(script: string, from: number): number {
  const delimiter = script[from + 1];
  let seen = 0;
  for (let k = from + 2; k < script.length; k++) {
    if (script[k] === "\\") k++;
    else if (script[k] === delimiter && ++seen === 2) return k + 1;
  }
  return -1;
}
/** The index of the end of the line at `from` (the script's end when there is none). */
function endOfLine(script: string, from: number): number {
  const end = script.indexOf("\n", from);
  return end < 0 ? script.length : end;
}
/** `a`, `i` and `c` take text that runs on while a line ends with a backslash: none of it is a command. */
function endOfSedText(script: string, from: number): number {
  let end = endOfLine(script, from);
  while (end < script.length && script[end - 1] === "\\") end = endOfLine(script, end + 1);
  return end;
}
function sedScriptExecutes(script: string): boolean {
  let k = 0;
  while (k < script.length) {
    const rest = script.slice(k).replace(/^[\s;{}]+/, "");
    k = script.length - rest.length;
    if (rest === "") return false;
    const body = rest.replace(SED_ADDRESS, "");
    k += rest.length - body.length;
    const command = body[0] ?? "";
    if (command === "e") return true;
    if (command === "s" || command === "y") {
      const flagsAt = sedSections(script, k);
      if (flagsAt < 0) return false;
      const flags = /^[A-Za-z0-9]*/.exec(script.slice(flagsAt))?.[0] ?? "";
      if (command === "s" && flags.includes("e") && !flags.includes("w")) return true;
      k = flagsAt + flags.length;
    } else if (/[aic]/.test(command)) k = endOfSedText(script, k);
    else if (/[rRwW:]/.test(command)) k = endOfLine(script, k);
    else k++;
  }
  return false;
}
/** The scripts a sed command line runs: the values of `-e`/`--expression`, else its first operand (`-f FILE` is unreadable). */
function sedScripts(args: readonly string[]): string[] {
  const expressions: string[] = [];
  const operands: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "--expression" || (/^-[A-Za-z]+$/.test(a) && a.endsWith("e"))) {
      expressions.push(args[++k] ?? "");
    } else if (a.startsWith("--expression=")) expressions.push(a.slice("--expression=".length));
    else if (a === "-f" || a === "--file") k++;
    else if (!a.startsWith("-") && a !== "") operands.push(a);
  }
  return expressions.length > 0 ? expressions : operands.slice(0, 1);
}
const sedExecutes: FlagTest = (args) => sedScripts(args).some(sedScriptExecutes);

/** `python -m json.tool IN OUT` writes OUT; `-m venv|zipfile|tarfile|compileall|…` write whatever they are handed. */
const WRITING_MODULE =
  /^(?:venv|zipfile|tarfile|compileall|py_compile|cProfile|profile|trace|pip|ensurepip|shutil|gzip|bz2|lzma|sqlite3)$/;
const pythonWrites: FlagTest = (args) => {
  const at = args.indexOf("-m");
  if (at < 0) return false;
  const [module = "", ...rest] = args.slice(at + 1);
  if (module === "json.tool") return rest.filter((a) => !a.startsWith("-")).length >= 2;
  return WRITING_MODULE.test(module);
};

/** `ruff format` rewrites in place unless `--check` or `--diff`; `ruff check` writes only with `--fix`, `--add-noqa`, an output file. */
const ruffWrites: FlagTest = (args) =>
  (args.includes("format") && !args.includes("--check") && !args.includes("--diff")) ||
  opt("--fix", "--fix-only", "--unsafe-fixes", "--add-noqa", "--output-file", "--cache-dir")(args);

type ReaderEntry = readonly [names: string, write?: WriteFlags];

/**
 * Programs that only read what they are handed, or run code whose own writes the classifier judges elsewhere. A write
 * flag turns one into a program the backstop watches. The names are the read/check programs that name a protected path most
 * often in this repo's real commands; the write flags are from each tool's own manual (most of these tools are not installed
 * on the machine this stack was built on, so a flag read from documentation alone says so in the wave-8 section of the doc).
 */
const READER_ENTRIES: readonly ReaderEntry[] = [
  // print, list, compare, measure
  ["cat head tail nl tac wc ls ll la stat bat du df diffstat column fold fmt"],
  ["diff colordiff cmp comm expand unexpand rev paste join seq cut tr od hexdump strings"],
  ["jq rg grep egrep fgrep ag ack fd find realpath readlink dirname basename pwd"],
  ["sha256sum sha1sum shasum md5sum md5 cksum b2sum which whereis type command printenv"],
  ["date id whoami uname hostname sleep eza exa lsof open"],
  // their own writes are modelled by name (`sort -o`, `uniq IN OUT`, `xxd IN OUT`, `find -fprint`)
  ["sort uniq xxd"],
  ["less more", writes(anyOf(letter("oO"), opt("--log-file", "--LOG-FILE")), "-o", "out.log")],
  ["file", writes(word("-C", "--compile"), "-C", "-m", "magic")],
  ["tree", writes(letter("o"), "-o", "out.txt")],
  ["awk gawk mawk", writes(awkWrites, "BEGIN{printf 1 > ARGV[1]}")],
  ["sed", writes(sedExecutes, "e cp a b")],
  ["redis-cli", writes(opt("--rdb", "--functions-rdb"), "--rdb", "dump.rdb")],
  // code and project measurement
  [
    "cloc",
    writes(
      opt(
        "--out",
        "--report-file",
        "--sql",
        "--ignored",
        "--counted",
        "--diff-alignment",
        "--found",
        "--unique",
      ),
      "--out=report.txt",
    ),
  ],
  ["tokei"],
  ["scc", writes(opt("-o", "--output"), "-o", "report.txt")],
  ["cspell", writes(opt("--cache-location", "--issue-template"), "--cache-location", "c")],
  ["depcruise dependency-cruiser", writes(opt("-f", "--output-to"), "--output-to", "report.json")],
  ["shfmt", writes(letter("w"), "-w")],
  ["ruff", writes(ruffWrites, "format")],
  [
    "semgrep",
    writes(
      anyOf(opt("-o", "--output", "--autofix"), (a) =>
        a.some((x) => /^--[a-z-]+-output(?:=|$)/.test(x)),
      ),
      "--sarif-output",
      "out.sarif",
    ),
  ],
  ["trivy", writes(opt("-o", "--output", "--cache-dir"), "-o", "report.txt")],
  ["code", writes(opt("--user-data-dir", "--extensions-dir"), "--user-data-dir", "dir")],
  // make runs recipes the guard cannot read, as `bun run NAME` runs a script; its own options write nothing
  ["make"],
  // linters and scanners that only report
  ["shellcheck hadolint actionlint yamllint"],
  [
    "gitleaks",
    writes(anyOf(opt("-r", "--report-path"), letter("r")), "detect", "-r", "report.json"),
  ],
  ["markdownlint markdownlint-cli2", writes(opt("--fix", "-o", "--output"), "--fix")],
  // shell keywords: the commands in their bodies are judged one by one
  ["for while until if then else elif fi do done case esac select function in { } ! ("],
  // shell builtins and the shell itself
  [
    "cd pushd popd echo printf true false test [ [[ source . bash sh zsh dash ksh exec nohup set export",
  ],
  // `time -o FILE` is a wrapper option: the classifier reads it where it peels the wrapper (`wrapperFiles`)
  ["time"],
  // interpreters, runners and checkers: they run a script or check files; their own writes are judged elsewhere
  [
    "bun",
    writes(
      opt(
        "--cwd",
        "-C",
        "--prefix",
        "--reporter-outfile",
        "--coverage-dir",
        "--cache-dir",
        "--outfile",
        "--outdir",
      ),
      "test",
      "--reporter-outfile",
      "r.xml",
    ),
  ],
  [
    "node",
    writes(
      opt(
        "--redirect-warnings",
        "--cpu-prof-dir",
        "--heap-prof-dir",
        "--report-dir",
        "--report-directory",
        "--report-filename",
        "--cpu-prof-name",
        "--heap-prof-name",
        "--trace-event-file-pattern",
        "--diagnostic-dir",
      ),
      "--redirect-warnings",
      "w.txt",
      "x.js",
    ),
  ],
  [
    "deno",
    writes(
      anyOf(opt("-o", "--output", "--root"), word("bundle", "vendor")),
      "compile",
      "-o",
      "out",
    ),
  ],
  ["python python3", writes(pythonWrites, "-m", "json.tool", "in.json", "out.json")],
  ["ruby", writes((a) => a.some((x) => /^-[A-Za-z]*i/.test(x)), "-i", "-pe", "x")],
  ["php lua tsx ts-node"],
  [
    "npm pnpm yarn",
    writes(
      opt(
        "--prefix",
        "--cwd",
        "-C",
        "--dir",
        "--workspace-root",
        "--cache",
        "--userconfig",
        "--global-folder",
        "--modules-folder",
        "--cache-folder",
      ),
      "install",
      "--prefix",
      "dir",
    ),
  ],
  ["tsc vitest"],
  [
    "jest",
    writes(
      opt("--outputFile", "--coverageDirectory", "--cacheDirectory"),
      "--outputFile",
      "r.json",
    ),
  ],
  [
    "mocha",
    writes(
      opt("-O", "--reporter-option", "--reporter-options", "--output"),
      "--reporter-options",
      "output=r",
    ),
  ],
  [
    "playwright",
    writes(
      anyOf(opt("--output", "-o"), word("screenshot", "pdf", "codegen")),
      "screenshot",
      "url",
      "out.png",
    ),
  ],
  [
    "biome",
    writes(
      (a) => a.some((x) => /^--(?:write|fix|apply|apply-unsafe|unsafe)$/.test(x)),
      "check",
      "--write",
    ),
  ],
  ["eslint", writes(opt("--fix"), "--fix")],
  ["prettier", writes(anyOf(opt("--write"), word("-w")), "--write")],
  // containers: their writes are judged as the command run inside, or by the bind-mount rules
  [
    "docker docker-compose podman nerdctl",
    writes(
      anyOf(
        word("cp", "save", "export", "buildx"),
        opt("-o", "--output", "--iidfile", "--cidfile", "--metadata-file"),
      ),
      "build",
      "-o",
      "out",
      ".",
    ),
  ],
  // plutil edits a property list in place unless `-o` says where the result goes
  [
    "plutil",
    writes(
      anyOf(word("-replace", "-insert", "-remove", "-extract", "-convert", "-create"), opt("-o")),
      "-remove",
      "k",
    ),
  ],
  // archivers: cpio and pax read an archive unless told to create one
  [
    "cpio",
    writes(anyOf(letter("oOpA"), opt("--create", "--pass-through", "--append")), "-o", "-O", "out"),
  ],
  ["pax", writes(letter("w"), "-w", "-f", "out")],
];

/** Every reader by name; the value is its write flags, when it has any. Exported for the consistency test. */
export const READERS: ReadonlyMap<string, WriteFlags | null> = new Map(
  READER_ENTRIES.flatMap(([names, flags]) =>
    names
      .split(" ")
      .filter(Boolean)
      .map((name): [string, WriteFlags | null] => [name, flags ?? null]),
  ),
);

/**
 * Programs the classifier models by name, so their own rules judge what they write and their positional operands are what
 * they read, write or take as a source. The write shape that proves each is asked in `harness-protected-operands.test.ts`.
 */
export const MODELLED: ReadonlySet<string> = new Set(
  (
    "cp mv ln install rsync scp ssh ditto rm unlink shred rmdir tee touch truncate mkdir " +
    "ed ex vi vim nvim nano chmod chown chgrp setfacl chflags xattr perl dd git patch " +
    "tar gtar bsdtar zip unzip gzip gunzip bzip2 bunzip2 xz unxz lzma unlzma zstd unzstd compress uncompress " +
    "sponge yq pg_dump pg_dumpall pg_restore psql pgcli sqlite3 mysql mariadb mycli script base64 openssl gpg gpg2 " +
    "curl wget split csplit shuf pandoc gh"
  ).split(" "),
);

const isOption = (a: string): boolean => a.startsWith("-") && a !== "-";

/** A word and whether it stood alone (a positional operand) or was attached to an option (`--out=P`, `-o=P`, `key=P`). */
export interface Candidate {
  readonly word: string;
  readonly positional: boolean;
}

/**
 * The words of a command that could name a file: every word that is not an option, the value of `--option=value`, of
 * `key=value` and of an attached short option (`-o=file`; `-ofile/x`, only when it has a slash). A word with whitespace
 * is prose here (see {@link embeddedNames}).
 */
export function pathCandidateList(args: readonly string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const a of args) {
    if (a === "" || a === "-" || /\s/.test(a)) continue;
    // `--out=P`, and Go's and clap's `-coverprofile=P`: a single dash, a name, `=`.
    const long = /^--?[A-Za-z][\w-]*=(.+)$/s.exec(a);
    const attached = /^-[A-Za-z](.*\/.*)$/s.exec(a);
    const keyed = /^[A-Za-z_]+=(.+)$/s.exec(a);
    if (long) out.push({ word: long[1] as string, positional: false });
    else if (attached) out.push({ word: attached[1] as string, positional: false });
    else if (isOption(a)) continue;
    else if (keyed) out.push({ word: keyed[1] as string, positional: false });
    else out.push({ word: a, positional: true });
  }
  return out;
}

/** The same words as {@link pathCandidateList}, flat. */
export const pathCandidates = (args: readonly string[]): string[] =>
  pathCandidateList(args).map((c) => c.word);

/** How the backstop treats one command. */
export interface BackstopPlan {
  /** Words to resolve and test against the protected set. */
  readonly words: readonly string[];
  /** Names found inside an inline program or a command text (a SQL string, an editor command): each judged as a path name. */
  readonly names: readonly string[];
  /**
   * May the repo root (`.`, `..`, `/`, `$PWD`) count as naming the protected files under it? Only when the command line
   * carries a write flag (`--write .`, `-w .`): a scanner or a helper script handed `.` reads (wave 8 corpus: 11 `ecc-agentshield
   * scan --path .`, 11 `live.sh "$PWD"`); a directory that holds protected files but is not the root (`scripts`) always counts.
   */
  readonly rootCounts: boolean;
  /** Is the program neither a reader nor modelled, and its command line asks for a recursive or all-files read (`-r`, `-a`, `--hidden`)? */
  readonly recursiveRead: boolean;
}

/** An option that makes an unknown program read every file under a directory operand, hidden and ignored ones included. */
const RECURSIVE_READ_FLAG =
  /^-[A-Za-z]*[rRaA]|^--(?:recursive|all|hidden|no-ignore|unrestricted|deep)/;
const asksRecursiveRead = (args: readonly string[]): boolean =>
  args.some((a) => RECURSIVE_READ_FLAG.test(a));

/** An option that makes an otherwise unknown program write in place or to a named output. */
const GENERIC_WRITE_FLAG =
  /^(?:-w|-i|-o|-O|--write|--fix|--apply|--in-?place|--output|--out|--overwrite)(?:=|$)|^-[A-Za-z]*[wi]$/;
const writesInPlace = (args: readonly string[]): boolean =>
  args.some((a) => GENERIC_WRITE_FLAG.test(a));

/** A word that is code or a command, not a name: whitespace, or the punctuation of a call, a string, a statement or a pipe. */
const CODE_LIKE = /[\s()"'`;{}|<>]/;

/** Characters that separate names inside text: whitespace, quotes, brackets, `=` and the editors' command punctuation. */
const NAME_BREAK = /[\s'"`(),;{}|<>[\]=!+:]+/;
const MAX_EMBEDDED_NAMES = 400;
const MAX_NAME_CHARS = 300;

/**
 * The names inside text: `sqlite3 :memory: "select readfile('<file>')"`, `vim -c ':w! <file>'`, `awk '{print > "<file>"}'`.
 * The tokens that look like a path (a dot or a slash), bounded. With `every` false only a word that is code-like (it holds
 * whitespace, a quote, a bracket or a pipe) is read: a bare file name is a candidate word, judged as a path. This is not done
 * for a modelled program (a commit message names paths in prose).
 */
export function embeddedNames(texts: readonly string[], every = false): string[] {
  const out: string[] = [];
  for (const text of texts) {
    if (!every && !CODE_LIKE.test(text)) continue;
    for (const token of text.split(NAME_BREAK)) {
      if (token.length < 2 || token.length > MAX_NAME_CHARS) continue;
      if (!/[./]/.test(token) && !/^codeowners$/i.test(token)) continue;
      out.push(token);
      if (out.length >= MAX_EMBEDDED_NAMES) return out;
    }
  }
  return out;
}

/**
 * What the backstop should look at for this command: null when the program only reads (and carries no write flag), else the
 * words and embedded names to test (`isLocalFunction`: the command defines this program as a function; `hereStrings`: what
 * `<<<` hands it). An editor's own command texts (arguments, standard input) are read by the client
 * reader (`db-client-escapes.ts`).
 */
export function backstopPlan(
  prog: string,
  args: readonly string[],
  isLocalFunction = false,
  hereStrings: readonly string[] = [],
): BackstopPlan | null {
  // No name, or an option of the image's own entry point that a container run left (`-x /mnt/a.sh`): no program.
  if (prog === "" || isOption(prog)) return null;
  const reader = READERS.get(prog);
  if (reader !== undefined && !(reader?.test(args) ?? false)) return null;
  const candidates = pathCandidateList(args);
  const rootCounts = reader !== undefined || writesInPlace(args);
  if (MODELLED.has(prog)) {
    return {
      words: candidates.filter((c) => !c.positional).map((c) => c.word),
      names: [],
      rootCounts,
      recursiveRead: false,
    };
  }
  // A function the command defines is called with prose as often as with code (`mk "title" "body that names a path"`): its
  // BODY is judged as commands, so its arguments are read as words only.
  const names = isLocalFunction ? [] : embeddedNames([...args, ...hereStrings]);
  const recursiveRead = reader === undefined && asksRecursiveRead(args);
  return { words: candidates.map((c) => c.word), names, rootCounts, recursiveRead };
}

/** `name() {`, `name () {` and `function name {`: the functions a command line defines for itself. */
const FUNCTION_DEFINITION =
  /(?:^|[\s;&|(){}])(?:function\s+([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*)\s*\(\s*\)\s*\{)/g;
export function localFunctionNames(cmd: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const m of cmd.matchAll(FUNCTION_DEFINITION)) names.add((m[1] ?? m[2]) as string);
  return names;
}

/** Could this command write a file its arguments name, in a way the classifier has no model for? (A plan exists.) */
export const writeCapable = (prog: string, args: readonly string[]): boolean =>
  backstopPlan(prog, args) !== null;
