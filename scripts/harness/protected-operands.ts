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

/**
 * Could this command write a file its arguments name, in a way the classifier has no model for? True for a program that
 * is on neither list, and for a checker run with the option that makes it write in place (`biome check --write`). A
 * package runner is already gone: the classifier reads the program it starts (`runners.ts`).
 */
export function writeCapable(prog: string, args: readonly string[]): boolean {
  // No name, or an option of the image's own entry point that a container run left (`-x /mnt/a.sh`): no program.
  if (prog === "" || isOption(prog)) return false;
  const flagged = WRITE_FLAGS.get(prog);
  if (flagged) return flagged(args);
  return !READ_ONLY.has(prog) && !MODELLED.has(prog);
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
