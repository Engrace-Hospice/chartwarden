/**
 * More programs that write a file or directory their command line names (round-5 ADV5-2), beyond `writers.ts`:
 * `bun build --outfile`, `tsc --outFile`, `vitest --outputFile`, `eslint -o`, `uniq IN OUT`, `split`, `shuf -o`,
 * compilers' `-o`, `curl --etag-save`, `wget --save-cookies`, `ssh -E`, `gh release download`, `docker cp`, and the `git`
 * subcommands that write outside `.git` (`worktree add`, `init DIR`, `clone SRC DIR`, `merge-file`, …). The classifier
 * judges each name returned here like a redirect target. A text heuristic for a cooperative agent: the class is
 * unbounded, so the generic backstop (`protected-operands.ts`) asks about the rest. Each option below was read from
 * the tool's own `--help` or manual on the machine the stack was built on, except `gh api --output`, which gh refuses.
 * Pure.
 */
import { type LongOption, optionValues } from "./option-values";

type Rule = (args: readonly string[]) => string[];

const isOption = (a: string): boolean => a.startsWith("-") && a !== "-";

/** The words that are not options, skipping the value of each option `valued` matches; everything after `--`. */
function operands(args: readonly string[], valued: RegExp = /^$/): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "--") return [...out, ...args.slice(k + 1)];
    if (valued.test(a)) k++;
    else if (!isOption(a)) out.push(a);
  }
  return out;
}

/** The value of each of these long options, matched whatever its case (tsc), as `--name value` or `--name=value`. */
function caseBlindValues(args: readonly string[], names: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (!names.has(a.slice(2, eq < 0 ? undefined : eq).toLowerCase())) continue;
    const value = eq < 0 ? args[++k] : a.slice(eq + 1);
    if (value) out.push(value);
  }
  return out;
}

/** The long options of one tool, exactly spelled (no abbreviation): the fewest characters is the whole name. */
const exact = (...names: string[]): LongOption[] => names.map((n) => [n, n.length]);

const TSC_OUTPUTS: ReadonlySet<string> = new Set([
  "outfile",
  "out",
  "outdir",
  "declarationdir",
  "tsbuildinfofile",
  "generatetrace",
  "generatecpuprofile",
]);

/** `vitest --outputFile F`, `--outputFile.junit=F` (one output per reporter) and `--coverage.reportsDirectory=D`. */
const vitestOutputs: Rule = (args) => {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const m = /^--(outputFile(?:\.[\w-]+)?|coverage\.reportsDirectory)(?:=(.*))?$/.exec(
      args[k] as string,
    );
    if (!m) continue;
    const value = m[2] ?? args[++k];
    if (value) out.push(value);
  }
  return out;
};

/** `-E FILE` is ssh's debug log; `-S` its control socket (scp's `-S` is a program, not a file). */
const SSH_WRITING_OPTIONS = /^(?:UserKnownHostsFile|GlobalKnownHostsFile|ControlPath)$/i;
const sshWrites: Rule = (args) => {
  const out = optionValues(args, "E", []).concat(optionValues(args, "S", []));
  for (const text of optionValues(args, "o", [])) {
    const m = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.+)$/s.exec(text);
    if (m && SSH_WRITING_OPTIONS.test(m[1] as string)) out.push(m[2] as string);
  }
  return out;
};

/** `wget -e output_document=F`: the wgetrc commands that name a file wget writes. */
const WGETRC_FILE =
  /^(?:output_document|dir_prefix|logfile|save_cookies|hsts_file|rejected_log|warc_file)$/i;
const wgetExecuted: Rule = (args) =>
  optionValues(args, "e", [["execute", 3]]).flatMap((text) => {
    const m = /^([A-Za-z_]+)\s*=\s*(.+)$/s.exec(text);
    return m && WGETRC_FILE.test(m[1] as string) ? [m[2] as string] : [];
  });

const GH_VALUE =
  /^(?:-[RtApDOnqjs]|--(?:repo|pattern|archive|dir|output|name|clobber|skip-existing))$/;
const ghWrites: Rule = (args) => {
  const [group, verb] = operands(args);
  const dirs = optionValues(args, "D", [["dir", 3]]);
  if (group === "release" && verb === "download") {
    return [...dirs, ...optionValues(args, "O", [["output", 6]])];
  }
  if (group === "run" && verb === "download") return dirs;
  if ((group === "repo" || group === "gist") && verb === "clone") {
    const [, , source, dest] = operands(
      args.filter((a) => a !== "--"),
      GH_VALUE,
    );
    return dest !== undefined ? [dest] : source === undefined ? [] : [cloneName(source)];
  }
  return [];
};

/** The directory `git clone SRC` and `gh repo clone SRC` create: the last path word without `.git`. */
const cloneName = (source: string): string =>
  (source.split(/[/:]/).filter(Boolean).at(-1) ?? "").replace(/\.git$/, "");

/** `docker cp C:/a DEST` writes DEST on this machine; `docker cp SRC C:/a` writes the container. */
const dockerWrites: Rule = (args) => {
  const [verb, first, second] = operands(args);
  if (verb === "cp") return first?.includes(":") && second !== undefined ? [second] : [];
  if (verb === "save" || verb === "export") return optionValues(args, "o", [["output", 6]]);
  return [];
};

const dashO: Rule = (args) => optionValues(args, "o", []);

const RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  [
    "bun",
    (args) =>
      args[0] === "build"
        ? optionValues(args, "", exact("outfile", "outdir", "metafile", "metafile-md"))
        : [],
  ],
  ["tsc", (args) => caseBlindValues(args, TSC_OUTPUTS)],
  ["vitest", vitestOutputs],
  [
    "eslint",
    (args) =>
      optionValues(args, "o", [
        ["output-file", 6],
        ["cache-location", 7],
      ]),
  ],
  ["biome", (args) => optionValues(args, "", exact("log-path", "log-file"))],
  ["uniq", (args) => operands(args, /^-[fsw]$/).slice(1, 2)],
  [
    "split",
    (args) => {
      const [, prefix] = operands(
        args,
        /^-[ablnp]$|^--(?:bytes|lines|suffix-length|number|filter)$/,
      );
      return [prefix ?? "x"];
    },
  ],
  [
    "csplit",
    (args) => {
      const prefixes = optionValues(args, "f", [["prefix", 3]]);
      return prefixes.length > 0 ? prefixes : ["xx"];
    },
  ],
  ["shuf", (args) => optionValues(args, "o", [["output", 6]])],
  ["pandoc", (args) => optionValues(args, "o", [["output", 6]])],
  ["go", (args) => (/^(?:build|test|install)$/.test(args[0] ?? "") ? dashO(args) : [])],
  ["curl", (args) => optionValues(args, "", exact("etag-save", "hsts", "alt-svc", "ssl-sessions"))],
  [
    "wget",
    (args) => [
      ...optionValues(args, "", [
        ["save-cookies", 6],
        ["hsts-file", 6],
        ["rejected-log", 8],
        ["warc-file", 6],
      ]),
      ...wgetExecuted(args),
    ],
  ],
  ["ssh", sshWrites],
  ["gh", ghWrites],
  ["docker", dockerWrites],
  ["podman", dockerWrites],
  ...[
    "cc",
    "gcc",
    "g++",
    "c++",
    "clang",
    "clang++",
    "rustc",
    "swiftc",
    "ld",
    "strip",
    "objcopy",
  ].map((compiler): [string, Rule] => [compiler, dashO]),
]);

const LAUNCHER_OPTION_WITH_VALUE = /^(?:-p|--package|--call|-c)$/;

/** The program a runner starts, and its arguments: `bunx tsc …`, `npx -y tsc …`, `bun x|run tsc …`, `pnpm exec tsc …`. */
function underRunner(
  prog: string,
  args: readonly string[],
): { prog: string; args: readonly string[] } {
  let rest: readonly string[] | undefined;
  if (/^(?:bunx|npx|pnpx)$/.test(prog)) rest = args;
  else if (prog === "bun" && /^(?:x|run)$/.test(args[0] ?? "")) rest = args.slice(1);
  else if (/^(?:pnpm|yarn|npm)$/.test(prog) && /^(?:exec|dlx)$/.test(args[0] ?? "")) {
    rest = args.slice(1);
  }
  if (rest === undefined) return { prog, args };
  let k = 0;
  while (isOption(rest[k] ?? "")) k += LAUNCHER_OPTION_WITH_VALUE.test(rest[k] as string) ? 2 : 1;
  const name = rest[k]?.replace(/^.*\//, "") ?? "";
  return { prog: name, args: rest.slice(k + 1) };
}

/** The files and directories `prog` writes because an option or operand names them; none for a program without a rule. */
export function moreWriterTargets(prog: string, args: readonly string[]): string[] {
  const run = underRunner(prog, args);
  return RULES.get(run.prog)?.(run.args) ?? [];
}

// ---------------------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------------------

const CLONE_VALUE =
  /^(?:-[bocj]|--(?:branch|origin|depth|reference|reference-if-able|template|config|jobs|filter|separate-git-dir|upload-pack|shallow-since|shallow-exclude|server-option|bundle-uri|revision|ref-format|object-format))$/;
const INIT_VALUE =
  /^(?:-b|--(?:template|object-format|ref-format|shared|initial-branch|separate-git-dir))$/;
const WORKTREE_VALUE = /^(?:-[bB]|--(?:reason|orphan))$/;
const MERGE_FILE_VALUE = /^(?:-L|--(?:marker-size|diff-algorithm|object-id))$/;
const TRAILER_VALUE = /^--(?:trailer|where|if-exists|if-missing)$/;
const SUBMODULE_VALUE = /^(?:-b|--(?:branch|name|reference|depth))$/;

function gitInit(rest: readonly string[]): string[] {
  const separate = optionValues(rest, "", [["separate-git-dir", 3]]);
  const dir = operands(rest, INIT_VALUE)[0];
  return [...separate, dir ?? "."];
}

function gitClone(rest: readonly string[]): string[] {
  const separate = optionValues(rest, "", [["separate-git-dir", 3]]);
  const [source, dest] = operands(rest, CLONE_VALUE);
  if (source === undefined) return separate;
  return [...separate, dest ?? cloneName(source)];
}

const GIT_RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ["fast-export", (rest) => optionValues(rest, "", [["export-marks", 8]])],
  [
    "fast-import",
    (rest) =>
      optionValues(rest, "", [
        ["export-marks", 8],
        ["export-pack-edges", 8],
      ]),
  ],
  [
    "worktree",
    (rest) => {
      const [verb, first, second] = operands(rest, WORKTREE_VALUE);
      if (verb === "add") return first === undefined ? [] : [first];
      return verb === "move" && second !== undefined ? [second] : [];
    },
  ],
  ["init", gitInit],
  ["clone", gitClone],
  ["pack-objects", (rest) => (rest.includes("--stdout") ? [] : operands(rest).slice(0, 1))],
  ["index-pack", (rest) => optionValues(rest, "o", [])],
  [
    "merge-file",
    (rest) =>
      rest.some((a) => a === "-p" || a === "--stdout")
        ? []
        : operands(rest, MERGE_FILE_VALUE).slice(0, 1),
  ],
  [
    "interpret-trailers",
    (rest) => (rest.includes("--in-place") ? operands(rest, TRAILER_VALUE) : []),
  ],
  ["checkout-index", (rest) => optionValues(rest, "", [["prefix", 3]])],
  ["read-tree", (rest) => optionValues(rest, "", [["index-output", 5]])],
  ["mailsplit", (rest) => optionValues(rest, "o", [])],
  ["mailinfo", (rest) => operands(rest).slice(0, 2)],
  ["bugreport", (rest) => optionValues(rest, "o", [["output-directory", 6]])],
  ["diagnose", (rest) => optionValues(rest, "o", [["output-directory", 6]])],
  [
    "submodule",
    (rest) => {
      if (rest[0] !== "add") return [];
      const [source, dest] = operands(rest.slice(1), SUBMODULE_VALUE);
      return source === undefined ? [] : [dest ?? cloneName(source)];
    },
  ],
]);

/** The paths a git subcommand writes outside `.git` because an option or operand names them (see `gitFileWrites` too). */
export function moreGitWrites(sub: string, rest: readonly string[]): string[] {
  return GIT_RULES.get(sub)?.(rest) ?? [];
}
