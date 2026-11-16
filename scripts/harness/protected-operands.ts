/**
 * The generic backstop for writers the classifier has no model for (round-5 ADV5-2). Five review rounds each found
 * another program that writes to a path the agent names (`bun build --outfile`, `uniq IN OUT`, `ssh -E`, …), and a
 * table of writers can never be complete. So a command that NAMES a protected path (a literal operand, an option value
 * or `key=value`, in any alias spelling) as an argument of a program that is neither known to only read, nor a writer
 * whose handling of its operands is modelled precisely elsewhere, asks (`unmodelledWriterVerdict` in the classifier).
 * Which program is which was chosen from the real commands of this repo's sessions (see the wave-7 section of
 * `docs/compliance/AGENT_HARNESS.md`): the read/check programs that name a protected path most often are listed, and
 * the long tail asks.
 *
 * A limit, not a boundary: a computed name (`$VAR/x`, `$(printf …)`), an encoded name and a path a script builds stay
 * unseen, and a word with whitespace is read as prose (a commit message), not as a path. The sandbox is the real
 * boundary. Pure.
 */

/** Programs that only read what they are handed, or run code whose own writes the classifier judges elsewhere. */
const READ_ONLY: ReadonlySet<string> = new Set([
  // print, list, compare, measure
  ...[
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "bat",
    "nl",
    "tac",
    "wc",
    "ls",
    "ll",
    "la",
    "stat",
    "file",
  ],
  ...["du", "df", "tree", "diff", "colordiff", "cmp", "comm", "diffstat", "column", "fold", "fmt"],
  ...["expand", "unexpand", "rev", "paste", "join", "seq", "cut", "tr", "xxd", "od", "hexdump"],
  ...["strings", "sort", "uniq", "jq", "awk", "gawk", "mawk", "rg", "grep", "egrep", "fgrep"],
  ...["ag", "ack", "fd", "find", "realpath", "readlink", "dirname", "basename", "pwd"],
  ...["sha256sum", "sha1sum", "shasum", "md5sum", "md5", "cksum", "b2sum", "which", "whereis"],
  ...["type", "command", "printenv", "date", "id", "whoami", "uname", "hostname", "sleep"],
  // linters and scanners that only report
  ...["shellcheck", "hadolint", "actionlint", "yamllint", "gitleaks", "markdownlint"],
  // shell keywords: the commands in their bodies are judged one by one
  ...["for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "case", "esac"],
  ...["select", "function", "in", "{", "}", "!", "("],
  // shell builtins and the shell itself
  ...["cd", "pushd", "popd", "echo", "printf", "true", "false", "test", "[", "[[", "source", "."],
  ...["bash", "sh", "zsh", "dash", "ksh", "exec", "time", "nohup", "set", "export"],
  // interpreters, runners and checkers: they run a script or check files; their own writes are judged elsewhere
  ...["bun", "node", "deno", "python", "python3", "ruby", "php", "lua", "tsx", "ts-node"],
  ...["npm", "pnpm", "yarn", "tsc", "vitest", "jest", "mocha", "playwright"],
  ...["biome", "eslint", "prettier", "sed"],
  // containers: their writes are judged as the command run inside, or by the bind-mount rules
  ...["docker", "docker-compose", "podman", "nerdctl"],
]);

/** Writers whose handling of a protected operand (as the written file, or as a source) the classifier models. */
const MODELLED: ReadonlySet<string> = new Set([
  ...["cp", "mv", "ln", "install", "rsync", "scp", "sftp", "ssh", "ditto", "rm", "unlink"],
  ...[
    "shred",
    "rmdir",
    "tee",
    "touch",
    "truncate",
    "mkdir",
    "ed",
    "ex",
    "vi",
    "vim",
    "nvim",
    "nano",
  ],
  ...["chmod", "chown", "chgrp", "setfacl", "chflags", "xattr", "perl", "dd", "git", "patch"],
  ...["tar", "gtar", "bsdtar", "zip", "unzip", "7z", "7za", "cpio", "pax", "gzip", "gunzip"],
  ...["bzip2", "bunzip2", "xz", "unxz", "lzma", "unlzma", "zstd", "unzstd", "compress"],
  ...["uncompress", "sponge", "plutil", "yq", "pg_dump", "pg_dumpall", "pg_restore", "psql"],
  ...["pgcli", "sqlite3", "mysql", "mariadb", "mycli", "script", "base64", "openssl", "gpg"],
  ...["gpg2", "curl", "wget", "split", "csplit", "shuf", "pandoc", "go", "cc", "gcc", "g++", "gh"],
  ...["c++", "clang", "clang++", "rustc", "swiftc", "ld", "strip", "objcopy", "env", "sudo"],
]);

type FlagTest = (args: readonly string[]) => boolean;
/** gawk's `-i inplace` (and the `include` form) edits its files where they are. */
const awkInPlace: FlagTest = (args) =>
  args.some((a, k) => a === "inplace" && /^(?:-i|--include)$/.test(args[k - 1] ?? ""));

/** A program that only reads, unless one of its arguments turns on writing in place. */
const WRITE_FLAGS: ReadonlyMap<string, FlagTest> = new Map<string, FlagTest>([
  ["biome", (args) => args.some((a) => /^--(?:write|fix|apply|apply-unsafe|unsafe)$/.test(a))],
  ["eslint", (args) => args.includes("--fix")],
  ["prettier", (args) => args.some((a) => a === "-w" || a === "--write")],
  ["awk", awkInPlace],
  ["gawk", awkInPlace],
  ["mawk", awkInPlace],
  ["ruby", (args) => args.some((a) => /^-[A-Za-z]*i/.test(a))],
]);

const isOption = (a: string): boolean => a.startsWith("-") && a !== "-";

/** A package-binary executor: the next word is the program (`bunx biome …`, `npx -y eslint …`, `pnpm exec prettier …`). */
const EXECUTOR_OPTION_WITH_VALUE = /^(?:-p|--package|--call|-c)$/;

/**
 * The program that really runs: `bunx|npx|pnpx X`, `bun x X`, `pnpm|yarn|npm exec|dlx X` name a binary; `bun|npm|pnpm|
 * yarn run X` names a package script, which is `bun` itself unless X is a tool the table knows by name.
 */
function executed(
  prog: string,
  args: readonly string[],
): { name: string; args: readonly string[] } {
  let rest: readonly string[] | undefined;
  let binary = true;
  if (/^(?:bunx|npx|pnpx)$/.test(prog)) rest = args;
  else if (prog === "bun" && args[0] === "x") rest = args.slice(1);
  else if (/^(?:pnpm|yarn|npm)$/.test(prog) && /^(?:exec|dlx)$/.test(args[0] ?? "")) {
    rest = args.slice(1);
  } else if (/^(?:bun|pnpm|yarn|npm)$/.test(prog) && args[0] === "run") {
    rest = args.slice(1);
    binary = false;
  }
  if (rest === undefined) return { name: prog, args };
  let k = 0;
  while (isOption(rest[k] ?? "")) k += EXECUTOR_OPTION_WITH_VALUE.test(rest[k] as string) ? 2 : 1;
  // `shellcheck@latest`, `@biomejs/biome@1.9.0`: the package spec, not the binary name.
  const name = rest[k]?.replace(/^.*\//, "").replace(/@[^@]*$/, "") ?? "";
  if (!binary && !WRITE_FLAGS.has(name)) return { name: prog, args };
  return { name, args: rest.slice(k + 1) };
}

/**
 * Could this command write a file its arguments name, in a way the classifier has no model for? True for a program that
 * is on neither list, and for a checker run with the option that makes it write in place (`biome check --write`).
 */
export function writeCapable(prog: string, args: readonly string[]): boolean {
  const run = executed(prog, args);
  // No name, or an option of the image's own entry point that a container run left (`-x /mnt/a.sh`): no program.
  if (run.name === "" || isOption(run.name)) return false;
  const flagged = WRITE_FLAGS.get(run.name);
  if (flagged) return flagged(run.args);
  return !READ_ONLY.has(run.name) && !MODELLED.has(run.name);
}

/**
 * The words of a command that could name a file: every word that is not an option, the value of `--option=value`, of
 * `key=value` and of an attached short option (`-ofile/x`, only when it has a slash). A word with whitespace is prose.
 */
export function pathCandidates(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a === "" || a === "-" || /\s/.test(a)) continue;
    const long = /^--[A-Za-z][\w-]*=(.+)$/s.exec(a);
    const attached = /^-[A-Za-z](.*\/.*)$/s.exec(a);
    const keyed = /^[A-Za-z_]+=(.+)$/s.exec(a);
    if (long) out.push(long[1] as string);
    else if (attached) out.push(attached[1] as string);
    else if (isOption(a)) continue;
    else out.push(keyed ? (keyed[1] as string) : a);
  }
  return out;
}
