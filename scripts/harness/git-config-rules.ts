/**
 * What `git config` (and `git -c`) may set. A key that makes git RUN a program, or switches its hooks off, runs
 * that program from a later, allowed `git status` outside the classifier: `core.worktree` re-pointed the Codex
 * hook at an attacker's script (ADV-C3), `core.fsmonitor`, `alias.x '!cmd'`, `core.sshCommand`, `core.pager`,
 * `core.editor`, `credential.helper`, `diff.external`, `filter.*.smudge`, `include.path` and a `core.hooksPath`
 * spelled in any case (the old rule was case-sensitive) are all that. One list serves both entry points.
 */
import { optionValues } from "./option-values";

/** Keys that make git run a program of the caller's choosing, read config from another file, or skip the hooks. */
export const GIT_EXEC_CONFIG = new RegExp(
  `^(?:${[
    String.raw`core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass|worktree|gitproxy)`,
    String.raw`alias\.`,
    String.raw`credential\.(?:.+\.)?helper`,
    String.raw`diff\.external`,
    String.raw`diff\..+\.(?:command|textconv)`,
    String.raw`merge\..+\.driver`,
    String.raw`(?:merge|diff)tool\..+\.(?:cmd|path)`,
    String.raw`filter\..+\.(?:smudge|clean|process)`,
    String.raw`include\.`,
    String.raw`includeif\.`,
    String.raw`pager\.`,
    // `protocol.allow` is the default policy of every protocol, `ext::` (which runs a command) included.
    String.raw`protocol\.(?:ext|allow$)`,
    String.raw`gpg\.(?:.+\.)?program`,
    String.raw`sequence\.editor`,
    String.raw`uploadpack\.packobjectshook`,
    String.raw`remote\..+\.(?:vcs|receivepack|uploadpack)`,
    String.raw`submodule\..+\.update`,
    String.raw`trailer\..+\.(?:cmd|command)`,
    String.raw`interactive\.difffilter`,
    // Named in `git help config` (and `git help archive` for `tar.<format>.command`) as a shell command or a program
    // git runs. Anchored where a longer key shares the prefix (`web.browserish`, `sendemail.smtpServerPort`).
    String.raw`core\.alternaterefscommand$`,
    String.raw`(?:browser|man)\..+\.(?:cmd|path)$`,
    String.raw`(?:web|help)\.browser$`,
    String.raw`guitool\..+\.cmd$`,
    String.raw`sendemail\.(?:.+\.)?(?:smtpserver|tocmd|cccmd)$`,
    String.raw`instaweb\.(?:httpd|browser)$`,
    String.raw`imap\.tunnel$`,
    String.raw`gpg\.ssh\.defaultkeycommand$`,
    String.raw`tar\..+\.command$`,
    String.raw`init\.templatedir`,
  ].join("|")})`,
  "i",
);

/** The key of a `-c key=value` or `--config-env=key=ENVVAR` operand. */
export const configKey = (kv: string): string => kv.split("=")[0] ?? "";

const SUBCOMMANDS = new Set([
  "get",
  "set",
  "unset",
  "list",
  "edit",
  "rename-section",
  "remove-section",
]);
/** Options that take the next word as their value (`--file x`, `-f x`). */
const VALUE_OPTIONS = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment"]);
const READ_OPTIONS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--get-urlmatch",
  "--get-color",
  "--get-colorbool",
  "-l",
  "--list",
]);
/** Options that write a value though only one operand (the key) may follow, or that take the value as a 2nd operand. */
const VALUE_WRITING_OPTIONS = new Set(["--add", "--replace-all"]);

export interface ConfigWrite {
  /** The key being set, as written. */
  readonly key: string;
  readonly value: string | undefined;
}

export interface ParsedConfig {
  /** The values this command sets (empty for a read, an unset, a listing). */
  readonly writes: readonly ConfigWrite[];
  /** The files named with `--file`/`-f`: the config goes there, not into the repository's. */
  readonly files: readonly string[];
}

/** Take apart the words after `git config`: which keys it sets, and which file it writes. */
export function parseGitConfig(rest: readonly string[]): ParsedConfig {
  const positionals: string[] = [];
  const files: string[] = [];
  let reads = false;
  let valueWriting = false;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? "";
    if (a === "--") {
      positionals.push(...rest.slice(k + 1));
      break;
    }
    if (VALUE_OPTIONS.has(a)) {
      if (a === "-f" || a === "--file") files.push(rest[k + 1] ?? "");
      k++;
    } else if (a.startsWith("--file=")) files.push(a.slice("--file=".length));
    else if (/^-f./.test(a)) files.push(a.slice(2));
    else if (/^--(blob|type|default|comment)=/.test(a)) continue;
    else if (READ_OPTIONS.has(a)) reads = true;
    else if (VALUE_WRITING_OPTIONS.has(a)) valueWriting = true;
    else if (a.startsWith("-")) continue;
    else positionals.push(a);
  }
  if (reads) return { writes: [], files };
  const [first, ...others] = positionals;
  // `git config set KEY VALUE` (git 2.46 and later) is the subcommand form of the legacy `git config KEY VALUE`.
  if (first !== undefined && SUBCOMMANDS.has(first)) {
    return first === "set" && others[0] !== undefined
      ? { writes: [{ key: others[0], value: others[1] }], files }
      : { writes: [], files };
  }
  if (first === undefined) return { writes: [], files };
  return others.length >= 1 || valueWriting
    ? { writes: [{ key: first, value: others[0] }], files }
    : { writes: [], files };
}

/** The one value of core.hooksPath that is the repo's own (`bun run hooks:install`-style setup). */
const REPO_HOOKS_PATH = ".githooks";

/**
 * Is this `git config` a write of an exec-capable key? The reason to give, or null. `core.hooksPath .githooks`
 * is the repo's own setup; every other value, in any spelling of the key, re-points or disables the hooks.
 */
export function gitConfigDenial(rest: readonly string[]): string | null {
  for (const { key, value } of parseGitConfig(rest).writes) {
    if (!GIT_EXEC_CONFIG.test(key)) continue;
    if (/^core\.hookspath$/i.test(key) && value === REPO_HOOKS_PATH) continue;
    return `\`git config ${key.length > 60 ? `${key.slice(0, 57)}...` : key}\` sets a key that makes git run a program of the caller's choosing, read configuration from another file, or skip the repo's hooks (core.worktree, core.fsmonitor, core.hooksPath, an alias, a pager, an editor, a helper, a filter, an include). It outlives this command and runs outside the guard, so a human sets it.`;
  }
  return null;
}

/**
 * The git commands whose diff or revision-walk machinery takes `--output=FILE` and writes it (each run in a scratch
 * repository on git 2.53; `stash show` shares the diff options but needs a stash to run). `diff`, `log` and `show`
 * are denied outright by the classifier; the rest are judged as a write onto FILE.
 */
const OUTPUT_FILE_COMMANDS: ReadonlySet<string> = new Set([
  "diff",
  "log",
  "show",
  "format-patch",
  "blame",
  "shortlog",
  "range-diff",
  "diff-tree",
  "diff-index",
  "diff-files",
  "whatchanged",
  "reflog",
  "difftool",
  "rev-list",
  "stash",
]);

/** The files a git subcommand writes through an option: `config --file F`, `--output F`, `archive -o F`, `bundle create F`. */
export function gitFileWrites(sub: string, rest: readonly string[]): string[] {
  if (sub === "config") return [...parseGitConfig(rest).files];
  // `credential-store --file F` stores a credential line in F; `credential-cache --socket F` creates the socket F.
  if (sub === "credential-store") return optionValues(rest, "", [["file", 4]]);
  if (sub === "credential-cache") return optionValues(rest, "", [["socket", 6]]);
  // git accepts only the full `--output` (an abbreviation is ambiguous with `--output-indicator-*`).
  if (OUTPUT_FILE_COMMANDS.has(sub)) return optionValues(rest, "", [["output", 6]]);
  if (sub === "archive") {
    const out: string[] = [];
    for (let k = 0; k < rest.length; k++) {
      const a = rest[k] ?? "";
      if (a === "-o" || a === "--output") out.push(rest[++k] ?? "");
      else if (a.startsWith("--output=")) out.push(a.slice("--output=".length));
      else if (/^-o./.test(a)) out.push(a.slice(2));
    }
    return out;
  }
  if (sub === "bundle" && rest[0] === "create") {
    const file = rest.slice(1).find((a) => !a.startsWith("-"));
    return file === undefined ? [] : [file];
  }
  return [];
}
