/**
 * Command lines git, and the variables it honours, hand to a shell (wave 4, T1).
 * ------------------------------------------------------------------------------------------------
 * `git rebase -x 'rm …'`, `git submodule foreach 'rm …'`, `git bisect run rm …`, `git difftool -x`, `git
 * filter-branch --tree-filter`, `git grep -O`, `git instaweb --httpd`, `git fetch --upload-pack` (run for a local
 * remote), and the variables `EDITOR`, `PAGER`, `GIT_SSH_COMMAND` … each carry a string a shell runs. The classifier
 * judges that string as a command line of its own, as it does for `watch`, `su -c` and `ssh h 'cmd'`
 * (`wrappers.ts`). The same variables can also inject git config (`GIT_CONFIG_KEY_n`, `GIT_CONFIG_PARAMETERS`: an
 * exec-capable key is denied exactly as `git -c` is) or re-point git at another tree. A text heuristic: a program
 * path (`GIT_ASKPASS=/tmp/x`, a script) is named, not read, and `ext::` remote URLs are refused by git itself unless
 * a config the guard already denies (`protocol.ext.allow`, `protocol.allow`) or `GIT_ALLOW_PROTOCOL` (asked) turns
 * them on. Pure.
 */
import { GIT_EXEC_CONFIG, configKey } from "./git-config-rules";
import { type LongOption, optionValues } from "./option-values";
import { VARIABLE_SETTERS, assignments } from "./shell-assignments";
import { shellQuote } from "./wrappers";

/** A string-valued option of one git subcommand: its short letter ("" for none) and its long spellings. */
type StringOption = readonly [short: string, long: readonly LongOption[]];

const FILTER_OPTIONS: readonly LongOption[] = [
  ["env-filter", 2],
  ["tree-filter", 2],
  ["index-filter", 2],
  ["parent-filter", 2],
  ["msg-filter", 2],
  ["commit-filter", 2],
  ["tag-name-filter", 2],
];

/** The options (per subcommand) whose value is a command line a shell runs. */
const OPTION_STRINGS: ReadonlyMap<string, readonly StringOption[]> = new Map([
  ["rebase", [["x", [["exec", 2]]]]],
  ["difftool", [["x", [["extcmd", 3]]]]],
  ["filter-branch", [["", FILTER_OPTIONS]]],
  [
    "instaweb",
    [
      ["d", [["httpd", 2]]],
      ["b", [["browser", 2]]],
    ],
  ],
  // The program a local-path remote runs: `git fetch --upload-pack 'cmd' /path`.
  ["clone", [["u", [["upload-pack", 3]]]]],
  ["fetch", [["", [["upload-pack", 3]]]]],
  ["pull", [["", [["upload-pack", 3]]]]],
  [
    "ls-remote",
    [
      [
        "",
        [
          ["upload-pack", 3],
          ["exec", 2],
        ],
      ],
    ],
  ],
  [
    "push",
    [
      [
        "",
        [
          ["receive-pack", 4],
          ["exec", 2],
        ],
      ],
    ],
  ],
  ["archive", [["", [["exec", 2]]]]],
]);

/** `git grep` options that take their value as the next word (so `-O` and a pattern are not confused). */
const GREP_VALUE_SHORT = /^-[ef]$/;
const PAGER_LONG: LongOption = ["open-files-in-pager", 4];

/** `-O<pager>` (also in a cluster, `-nO<pager>`) and `--open-files-in-pager=<pager>`: the value is always attached. */
function grepPagers(rest: readonly string[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] ?? "";
    if (a === "--") break;
    if (GREP_VALUE_SHORT.test(a)) k++;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const given = a.slice(2, eq < 0 ? undefined : eq);
      if (eq >= 0 && given.length >= PAGER_LONG[1] && PAGER_LONG[0].startsWith(given)) {
        out.push(a.slice(eq + 1));
      }
    } else {
      const pager = /^-[A-Za-z]*O(.+)$/s.exec(a)?.[1];
      if (pager !== undefined) out.push(pager);
    }
  }
  return out;
}

/** The words after `word` in `rest`, past the options (`--recursive`, `--quiet`) that follow it. */
function afterSubcommand(rest: readonly string[], word: string, skip: RegExp): string[] | null {
  const at = rest.findIndex((a) => !a.startsWith("-"));
  if (rest[at] !== word) return null;
  const words = rest.slice(at + 1);
  let k = 0;
  while (skip.test(words[k] ?? "")) k++;
  return words.slice(k);
}

/**
 * The command lines the git subcommand `sub` (with `rest` after it) hands to a shell, as strings to judge. Empty
 * for a subcommand that runs none.
 */
export function gitCommandStrings(sub: string, rest: readonly string[]): string[] {
  if (sub === "grep") return grepPagers(rest);
  if (sub === "submodule") {
    const words = afterSubcommand(rest, "foreach", /^(?:--recursive|-q|--quiet)$/);
    return words !== null && words.length > 0 ? [words.join(" ")] : [];
  }
  if (sub === "bisect") {
    // `git bisect run CMD ARGS…` runs the words as a command, not as one string.
    return rest[0] === "run" && rest.length > 1 ? [rest.slice(1).map(shellQuote).join(" ")] : [];
  }
  return (OPTION_STRINGS.get(sub) ?? []).flatMap(([short, long]) =>
    optionValues(rest, short, long),
  );
}

/**
 * What `git clone` writes into the NEW repository's config (`-c core.fsmonitor=…`, `--config key=value`): the same
 * `key=value` pairs `git -c` takes, for the same table to judge. A later, allowed `git -C new status` runs them.
 */
export const gitSubcommandConfigs = (sub: string, rest: readonly string[]): string[] =>
  sub === "clone" ? optionValues(rest, "c", [["config", 3]]) : [];

/** `git clone|init --template=DIR`: the template's hooks and config are copied into the new repository. */
export const usesGitTemplate = (sub: string, rest: readonly string[]): boolean =>
  (sub === "clone" || sub === "init") && optionValues(rest, "", [["template", 4]]).length > 0;

export const GIT_TEMPLATE_OPTION_REASON =
  "`--template` copies a template directory's hooks and config into the new repository, where they run outside the guard. A human decides.";
export const GIT_CLONE_CONFIG_REASON =
  "`git clone -c` / `--config` writes a key that makes git run a program (core.fsmonitor, core.hooksPath, an alias, a pager, a helper) into the new repository's config, where it runs from a later, allowed git command. A human sets it.";

// ---------------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------------

/**
 * Variables whose value is a command line (or a program) that something hands to a shell: git's own
 * (`GIT_SSH_COMMAND`, `GIT_PAGER`, `GIT_EDITOR` …), the editor and pager family every tool reads (`EDITOR`,
 * `MANPAGER`, `GH_PAGER`, `SUDO_EDITOR` …), and the few others a program runs with `sh -c`: `BROWSER`, `LESSOPEN`,
 * `RSYNC_RSH`, `PROMPT_COMMAND`. Each is judged as a command line, so `MANPAGER='rm …' man ls` is the `rm`.
 */
export const COMMAND_VARIABLES: ReadonlySet<string> = new Set([
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "PAGER",
  "MANPAGER",
  "BAT_PAGER",
  "GH_PAGER",
  "PSQL_PAGER",
  "EDITOR",
  "VISUAL",
  "FCEDIT",
  "SUDO_EDITOR",
  "KUBE_EDITOR",
  "GH_EDITOR",
  "SVN_EDITOR",
  "PSQL_EDITOR",
  "HGEDITOR",
  "CVSEDITOR",
  "LESSEDIT",
  "BROWSER",
  "GH_BROWSER",
  "LESSOPEN",
  "LESSCLOSE",
  "PROMPT_COMMAND",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "RSYNC_RSH",
  "CVS_RSH",
  "SVN_SSH",
  "FZF_DEFAULT_COMMAND",
]);

/** Variables that re-point git at another repository, another config or another set of helper programs. */
const REROOT_VARIABLES: ReadonlySet<string> = new Set([
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_ALLOW_PROTOCOL",
]);

/**
 * Variables git documents as naming a FILE it writes: every `GIT_TRACE*` sink, the Windows stream redirects, and the
 * index (git writes `GIT_INDEX_FILE` in place). `git help git` lists them; a `GIT_TRACE_*` that only changes what is
 * traced (`GIT_TRACE_REDACT`, `GIT_TRACE2_BRIEF`, `GIT_TRACE_CURL_NO_DATA`) is not here.
 */
const TRACE_VARIABLES: ReadonlySet<string> = new Set([
  "GIT_TRACE",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
  "GIT_TRACE_PACKET",
  "GIT_TRACE_PACKFILE",
  "GIT_TRACE_CURL",
  "GIT_TRACE_SETUP",
  "GIT_TRACE_PERFORMANCE",
  "GIT_TRACE_REFS",
  "GIT_TRACE_SHALLOW",
  "GIT_TRACE_FSMONITOR",
  "GIT_TRACE_PACK_ACCESS",
  "GIT_REDIRECT_STDOUT",
  "GIT_REDIRECT_STDERR",
]);
const FILE_VARIABLES: ReadonlySet<string> = new Set(["GIT_INDEX_FILE"]);
/** What a trace variable holds when it names no file: off, on, stderr, a file descriptor, `2>&1`, a socket. */
const TRACE_NOT_A_FILE = /^(?:[0-9]*|true|false|off|2>&1|af_unix:.*)$/i;

/** Programs whose arguments set variables for the shell that follows: `export NAME=v`. */
const VARIABLE_SETTER = new RegExp(`^(?:${VARIABLE_SETTERS.join("|")})$`);

/** The `NAME=value` words a command sets: its prefix assignments and, for `export` and kin, its arguments. */
export function assignmentWords(
  prog: string,
  args: readonly string[],
  assigns: readonly string[],
): string[] {
  return VARIABLE_SETTER.test(prog) ? [...assigns, ...args] : [...assigns];
}

/** The values of the variables that carry a command line (`EDITOR='rm x'`, `EDITOR+=…`), as strings to judge. */
export function envCommandStrings(words: readonly string[]): string[] {
  return assignments(words).flatMap(({ name, value }) =>
    COMMAND_VARIABLES.has(name) && value.trim() !== "" ? [value] : [],
  );
}

/**
 * The files the variables in `words` tell git to write (`GIT_TRACE=/path` appends a trace line to it, and a trace line
 * appended to the guard's own entry file makes the Claude hook exit 1, which Claude Code reads as allow). The caller
 * judges each like a redirect target.
 */
export function envWriteTargets(words: readonly string[]): string[] {
  return assignments(words).flatMap(({ name, value }) => {
    if (FILE_VARIABLES.has(name)) return value === "" ? [] : [value];
    return TRACE_VARIABLES.has(name) && !TRACE_NOT_A_FILE.test(value.trim()) ? [value] : [];
  });
}

/** One `'key=value'` (or `'key'='value'`) unit of `GIT_CONFIG_PARAMETERS`, as `key=value`. */
const PARAMETER_UNIT = /'((?:[^']|'\\'')*)'(?:=('(?:[^']|'\\'')*'))?/g;

/** The `key=value` pairs `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` and `GIT_CONFIG_PARAMETERS` inject, as `git -c` writes them. */
export function gitEnvConfigs(words: readonly string[]): string[] {
  const value = new Map<string, string>();
  const keys: Array<[string, string]> = [];
  const pairs: string[] = [];
  for (const { name, value: text } of assignments(words)) {
    if (name === "GIT_CONFIG_PARAMETERS") {
      for (const unit of text.matchAll(PARAMETER_UNIT)) {
        const [, key = "", quoted] = unit;
        pairs.push(quoted === undefined ? key : `${key}=${quoted.replace(/^'|'$/g, "")}`);
      }
    } else if (/^GIT_CONFIG_KEY_\d+$/.test(name))
      keys.push([name.slice("GIT_CONFIG_KEY_".length), text]);
    else if (/^GIT_CONFIG_VALUE_\d+$/.test(name))
      value.set(name.slice("GIT_CONFIG_VALUE_".length), text);
  }
  return [...pairs, ...keys.map(([n, key]) => `${key}=${value.get(n) ?? ""}`)];
}

export interface GitEnvVerdict {
  readonly decision: "ask" | "deny";
  readonly reason: string;
}

const ENV_CONFIG_REASON =
  "A GIT_CONFIG_* environment variable sets a key that makes git run a program of the caller's choosing, read configuration from another file, or skip the repo's hooks (core.fsmonitor, core.hooksPath, an alias, a pager, an editor, a helper), exactly as `git -c` would. A human sets it.";
const ENV_REROOT_REASON =
  "A GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE, GIT_EXEC_PATH, GIT_TEMPLATE_DIR, GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, GIT_ALLOW_PROTOCOL setting points git at another repository, another configuration or other helper programs, whose hooks and filters run outside the guard. A human decides.";

/** What the git-related variables in `words` call for: a deny for an exec-capable config key, an ask for a re-root. */
export function gitEnvVerdict(words: readonly string[]): GitEnvVerdict | null {
  if (gitEnvConfigs(words).some((kv) => GIT_EXEC_CONFIG.test(configKey(kv)))) {
    return { decision: "deny", reason: ENV_CONFIG_REASON };
  }
  return assignments(words).some(({ name }) => REROOT_VARIABLES.has(name))
    ? { decision: "ask", reason: ENV_REROOT_REASON }
    : null;
}

/** Git's global options that re-point it at another repository or helper directory (`--git-dir`, `--exec-path=`). */
export const isGitRerootOption = (arg: string): boolean =>
  /^--git-dir(?:=|$)|^--exec-path=/.test(arg);

/** An `ext::sh -c …` remote URL: git runs the command after the `::` (when its policy lets `ext` run at all). */
export const isExtUrl = (arg: string): boolean => /^ext::/i.test(arg);

export const GIT_EXT_URL_REASON =
  "An `ext::` remote URL makes git run the command after the `::`. A human decides.";

export const GIT_REROOT_OPTION_REASON =
  "`--git-dir` and `--exec-path=` point git at another repository or another set of helper programs, whose config, hooks and filters run outside the guard. A human decides.";
