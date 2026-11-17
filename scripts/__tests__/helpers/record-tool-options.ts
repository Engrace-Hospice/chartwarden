/**
 * Records, from the INSTALLED tool, which options of a command take a value (wave 11 part C, rule 12; round-8 R8-ADV-1..3, R8-CR-12).
 * -----------------------------------------------------------------------------------------------------------------------------------
 * Wave 10 shipped three deny-to-allow regressions (`bun run --cwd x CMD`, `pnpm --prefix x exec CMD`, `env -S`) because its option tables
 * were written from memory and WRONG ABOUT THE REAL TOOL (a valued option declared as a flag), and its monotonicity test iterated the same
 * table it was testing. This recorder is the other half: it asks the real tool, and writes what it found to a committed JSON fixture
 * (`scripts/__tests__/fixtures/harness-tool-options/<tool>.<version>.json`); `harness-tool-options-wave11.test.ts` holds the production
 * tables against the fixture on CI (no tool needed), and `harness-tool-options-live-wave11.test.ts` re-records live where the tool is installed.
 *
 * How an option is classified (never a payload that commits, pushes, writes outside a scratch directory, reads a secret or leaves this machine):
 * - `hit` tools (bun, pnpm, npm): `TOOL OPT VALUE echo HIT` and `TOOL OPT echo HIT` run in a scratch directory with a scrubbed environment and
 *   every registry and proxy pointed at 127.0.0.1:1 (a closed local port). A valued option consumes VALUE and `echo` runs: HIT, and the
 *   flag form does not. A flag leaves VALUE as the command: no HIT, and the flag form prints HIT. An option whose separate form does not
 *   consume the word (`bun run --config`, `-c`: the value rides after `=`) therefore reads as a flag, which is how the real tool reads it.
 * - `argument` tools (docker, podman, compose): `TOOL run --OPT` with nothing after it. pflag answers `flag needs an argument` for a valued
 *   option before any daemon is contacted (`-H tcp://127.0.0.1:1` is a closed local port in case one is), and `unknown flag` for a name the
 *   command does not have.
 * - `help` only: `bun x` (a flag would make the next word a package name to install) and `pnpm dlx` (it always installs): the value column of
 *   the tool's own `--help` text.
 * An option neither probe settles (an error before the command runs) is taken from the help column when the help says so, and is `unverified`
 * otherwise; the production tables ask on an unverified entry. Options the tool rejects are listed in `rejected` and left out.
 */
import { execFile, execFileSync } from "node:child_process";
import { constants, accessSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type TakesValue = boolean | "optional" | "unverified";
export type Evidence = "probe" | "help" | "unverified";

export interface RecordedOption {
  /** The option as typed, with its dashes (`--cwd`, `-i`). */
  readonly name: string;
  /** The short spelling of the same option (`-F` for `--filter`), when it has one. */
  readonly short?: string;
  readonly takesValue: TakesValue;
  readonly evidence: Evidence;
}

export interface ToolFixture {
  readonly tool: string;
  readonly version: string;
  /** The command the options belong to: `bun run`, `docker exec`. */
  readonly command: string;
  /** How the options were found out. */
  readonly method: "echo-hit" | "flag-needs-argument" | "help";
  readonly options: readonly RecordedOption[];
  /** Names the tool rejected (`unknown flag`, `Unknown option`): not options of this command. */
  readonly rejected: readonly string[];
  /** The subcommands the tool lists (`pnpm help -a`): any other first word is a program it runs. */
  readonly commands?: readonly string[];
}

// ---------------------------------------------------------------------------------------------------
// Finding the tool, and running it in a sandbox
// ---------------------------------------------------------------------------------------------------

const EXTRA_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/podman/bin",
  join(homedir(), ".bun", "bin"),
];

/** The binary `name` on PATH, then in the usual package-manager directories; undefined when it is not installed. */
export function findTool(name: string): string | undefined {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_BIN_DIRS];
  for (const dir of dirs) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

const LOOPBACK = "http://127.0.0.1:1/";
const PROBE_TIMEOUT_MS = 8000;
const CONCURRENCY = 6;

interface Sandbox {
  readonly cwd: string;
  readonly env: Record<string, string>;
  dispose(): void;
}

/** A scratch directory and a scrubbed environment: no secret reaches the tool and nothing leaves the machine. */
function makeSandbox(bin: string): Sandbox {
  const cwd = mkdtempSync(join(tmpdir(), "cw-record-"));
  const home = join(cwd, "home");
  mkdirSync(home);
  mkdirSync(join(cwd, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(cwd, "package.json"), '{"name":"scratch","version":"1.0.0","scripts":{}}\n');
  const node = findTool("node");
  const path = [dirname(bin), ...(node === undefined ? [] : [dirname(node)]), "/usr/bin", "/bin"];
  return {
    cwd,
    env: {
      PATH: path.join(delimiter),
      HOME: home,
      DOCKER_CONFIG: join(homedir(), ".docker"),
      npm_config_registry: LOOPBACK,
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      BUN_CONFIG_REGISTRY: LOOPBACK,
      HTTP_PROXY: LOOPBACK,
      HTTPS_PROXY: LOOPBACK,
      NO_COLOR: "1",
      CI: "true",
    },
    dispose: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

interface RunResult {
  readonly out: string;
  readonly err: string;
}

const run = (bin: string, argv: readonly string[], box: Sandbox): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = execFile(
      bin,
      [...argv],
      {
        cwd: box.cwd,
        env: box.env,
        timeout: PROBE_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1 << 20,
      },
      (_error, stdout, stderr) => resolve({ out: String(stdout), err: String(stderr) }),
    );
    child.stdin?.end();
  });

/** `fn` over `items`, at most CONCURRENCY at a time, results in order. */
async function pool<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < items.length; at = next++) results[at] = await fn(items[at] as T);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------------------------------
// Reading option names out of `--help`
// ---------------------------------------------------------------------------------------------------

interface Candidate {
  readonly name: string;
  readonly short?: string;
  /** The help text's own answer, when it gives one: a value placeholder after the name. */
  readonly helpValue?: boolean;
}

const OPTION_TOKEN = /(?:^|[\s,|=[])(-[A-Za-z0-9](?![\w-])|--(?:\[no-\])?[A-Za-z0-9][\w.-]*)/g;

/** The options one help line names: its head (up to the first run of two spaces) holds `-x, --name <value>`. */
function candidatesOfLine(line: string): Candidate[] {
  const match = /^\s{1,10}(-[^\s].*?)(?:\s{2,}|$)/.exec(line);
  if (match === null) return [];
  const head = match[1] as string;
  const names: string[] = [];
  for (const m of head.matchAll(OPTION_TOKEN)) {
    const token = m[1] as string;
    if (token.startsWith("--[no-]")) names.push(`--${token.slice(7)}`, `--no-${token.slice(7)}`);
    else names.push(token);
  }
  const longs = names.filter((n) => n.startsWith("--"));
  const short = names.find((n) => !n.startsWith("--"));
  const helpValue =
    /[<=]\S|\s(?:list|string|int|uint\d*|uints|bytes|duration|stringArray|map|decimal|float\d*|bool)(?:\s|$)/.test(
      head,
    );
  const base = longs.length === 0 ? (short === undefined ? [] : [short]) : longs;
  return base.map((name, at) => ({
    name,
    ...(short !== undefined && at === 0 && longs.length > 0 ? { short } : {}),
    helpValue,
  }));
}

/** Every option a help text lists, by name; the first spelling of a name wins. */
export function candidatesOf(...helpTexts: readonly string[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const text of helpTexts) {
    for (const line of text.split("\n")) {
      for (const candidate of candidatesOfLine(line)) {
        if (!seen.has(candidate.name)) seen.set(candidate.name, candidate);
      }
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------------------------------
// The targets
// ---------------------------------------------------------------------------------------------------

type Method = ToolFixture["method"];

interface Target {
  readonly key: string;
  readonly tool: string;
  readonly method: Method;
  /** Arguments that print the tool's version. */
  readonly versionArgs: readonly string[];
  /** The tool has no stable `--version` (BSD env): `bsd` or `gnu-X.Y` is the version. */
  readonly flavour?: boolean;
  /** Help texts to read option names from: the argument lists to run. */
  readonly helpArgs: ReadonlyArray<readonly string[]>;
  /** Extra names to probe that no help text lists (the config names npm and pnpm share). */
  readonly extraNames?: (bin: string, box: Sandbox) => Promise<readonly string[]>;
  /** Short letters to probe even when no help lists them. */
  readonly letters?: string;
  /** The subcommands the tool lists, when a first word that is none of them is a program it runs (pnpm). */
  readonly commands?: (bin: string, box: Sandbox) => Promise<readonly string[]>;
  /** Arguments for one probe: `value` undefined is the flag form. */
  readonly argv: (token: string, value?: string) => readonly string[];
  /** Options that must not run (they never return): taken from the help column. */
  readonly skip?: ReadonlySet<string>;
  /** Options that print and exit before the command runs: flags. */
  readonly exits?: ReadonlySet<string>;
  /** Values to try for a valued option until the command runs. */
  readonly values?: readonly string[];
  /** The text of the tool's error for a name the command does not have. */
  readonly rejects?: RegExp;
  /**
   * The flag form is no evidence (npx has no word of its own for a valued option to swallow, and reads `--tag --offline` as `--tag` with no
   * value): an option is valued when a run with a separate value reaches the command, and a flag otherwise.
   */
  readonly valuedOnly?: boolean;
  /** The help text marks every valued option (a placeholder after the name): a name without one is a flag. */
  readonly helpMarksFlags?: boolean;
  /**
   * What the tool's documentation says of an option no probe can settle (an option that needs a workspace, or a package to install): the
   * name, whether it takes a value, and where it says so. Used only when the probe found nothing, and recorded as `help` evidence.
   */
  readonly manual?: Readonly<Record<string, readonly [takesValue: boolean, source: string]>>;
}

const DOCKER_H = ["-H", "tcp://127.0.0.1:1"];
const DEFAULT_VALUES = [
  "x",
  "1",
  ".",
  "verbatim",
  "fallback",
  "bun",
  "silent",
  "X=1",
  ".x:js",
  "/dev/null",
  LOOPBACK,
  "darwin",
  "arm64",
  "glibc",
  "prod",
  "^",
  "all",
];
const EXIT_EARLY = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "-V",
  "--revision",
  "--usage",
  "-?",
]);

/** The config names npm knows (`npm config ls -l`): npm and pnpm both read them as `--name`. Empty when npm is not installed. */
const npmNames = async (_bin: string, box: Sandbox): Promise<string[]> => {
  const npm = findTool("npm");
  if (npm === undefined) return [];
  const { out } = await run(npm, ["config", "ls", "-l"], box);
  return [...out.matchAll(/^;?\s*([a-z][\w-]*) =/gm)].map((m) => `--${m[1]}`);
};

/**
 * pnpm's own settings (pnpm.io/settings): candidates only, from the documentation. pnpm reads each of them as `--name` too; the probe decides
 * whether the installed pnpm knows the name and whether it takes a value.
 */
const PNPM_SETTINGS = (
  "workspace-packages link-workspace-packages prefer-workspace-packages shared-workspace-lockfile save-workspace-protocol " +
  "ignore-workspace-cycles disallow-workspace-cycles include-workspace-root workspace-concurrency hoist hoist-workspace-packages " +
  "dedupe-peer-dependents dedupe-direct-deps dedupe-injected-deps auto-install-peers strict-peer-dependencies " +
  "resolve-peers-from-workspace-root node-linker symlink enable-modules-dir virtual-store-dir-max-length lockfile " +
  "prefer-frozen-lockfile lockfile-include-tarball-url git-branch-lockfile merge-git-branch-lockfiles-branch-pattern " +
  "peers-suffix-max-length use-node-version node-version node-mirror npm-path package-manager-strict manage-package-manager-versions " +
  "catalog-mode cleanup-unused-catalogs side-effects-cache side-effects-cache-readonly strict-store-pkg-content-check ignore-dep-scripts " +
  "unsafe-perm only-built-dependencies only-built-dependencies-file never-built-dependencies ignored-built-dependencies " +
  "minimum-release-age minimum-release-age-exclude pnpmfile global-pnpmfile ignore-pnpmfile use-store-server store-dir " +
  "state-dir global-bin-dir global-dir cache-dir git-checks publish-branch recursive-install engine-strict use-stderr " +
  "config-dir update-notifier registry-supports-time-field verify-store-integrity extend-node-path resolution-mode " +
  "sort-keys ignore-compatibility-db public-hoist-pattern hoist-pattern package-import-method modules-cache-max-age " +
  "dlx-cache-max-age fetching-concurrency lockfile-only reporter-hide-prefix test-pattern changed-files-ignore-pattern " +
  "filter filter-prod workspace-root workspace-dir link-workspace-packages-dir"
)
  .split(" ")
  .map((name) => `--${name}`);

const pnpmNames = async (bin: string, box: Sandbox): Promise<string[]> => [
  ...(await npmNames(bin, box)),
  ...PNPM_SETTINGS,
];

/** The command column of `pnpm help -a`: `i, install` is two names. */
const pnpmCommands = async (bin: string, box: Sandbox): Promise<string[]> => {
  const { out } = await run(bin, ["help", "-a"], box);
  const names = new Set<string>();
  for (const m of out.matchAll(
    /^ {2,6}(?:([a-z]{1,3}),\s+)?([a-z][a-z-]*)(?: [a-z-]+)?\s{2,}\S/gm,
  )) {
    if (m[1] !== undefined) names.add(m[1]);
    names.add(m[2] as string);
  }
  return [...names].sort();
};

export const TARGETS: readonly Target[] = [
  {
    key: "bun",
    tool: "bun",
    helpMarksFlags: true,
    method: "echo-hit",
    versionArgs: ["--version"],
    helpArgs: [["--help"]],
    argv: (t, v) => [t, ...(v === undefined ? [] : [v]), "run", "echo", "HIT"],
    skip: new Set([
      "--watch",
      "--hot",
      "--interactive",
      "--parallel",
      "--sequential",
      "--workspaces",
      "--check",
    ]),
    exits: EXIT_EARLY,
  },
  {
    key: "bun run",
    tool: "bun",
    helpMarksFlags: true,
    method: "echo-hit",
    versionArgs: ["--version"],
    helpArgs: [["run", "--help"]],
    argv: (t, v) => ["run", t, ...(v === undefined ? [] : [v]), "echo", "HIT"],
    skip: new Set([
      "--watch",
      "--hot",
      "--interactive",
      "--parallel",
      "--sequential",
      "--workspaces",
      "--check",
    ]),
    exits: EXIT_EARLY,
  },
  {
    key: "bun x",
    tool: "bun",
    helpMarksFlags: true,
    method: "help",
    versionArgs: ["--version"],
    helpArgs: [["x", "--help"]],
    argv: () => [],
  },
  {
    key: "pnpm",
    tool: "pnpm",
    method: "echo-hit",
    versionArgs: ["--version"],
    // Options stand BEFORE `exec`: pnpm 10.30 reads everything after `exec` as the command (`pnpm exec -r echo HIT` runs a program named `-r`).
    helpArgs: [
      ["help"],
      ["help", "exec"],
      ["help", "recursive"],
      ["help", "install"],
      ["help", "add"],
      ["help", "run"],
      ["help", "dlx"],
      ["help", "config"],
      ["help", "update"],
      ["help", "list"],
      ["help", "publish"],
    ],
    extraNames: pnpmNames,
    letters: "CFcgrswDEOPTdhilmnpqv",
    commands: pnpmCommands,
    argv: (t, v) => [t, ...(v === undefined ? [] : [v]), "exec", "echo", "HIT"],
    exits: EXIT_EARLY,
    rejects: /Unknown option/,
    // Options that need a workspace (so every probe errors before `echo` runs) and that `pnpm help` states without a placeholder.
    manual: {
      "--workspace-root": [
        false,
        "pnpm help exec: `-w, --workspace-root  Run the command on the root workspace project`",
      ],
      "-w": [false, "pnpm help exec"],
    },
  },
  {
    key: "pnpm dlx",
    tool: "pnpm",
    method: "help",
    versionArgs: ["--version"],
    helpArgs: [["help", "dlx"]],
    argv: () => [],
    // `pnpm help dlx` leaves the value placeholder off; pnpm.io/cli/dlx documents `--package <name>`, `--allow-build <name>`, `--reporter <name>`.
    manual: {
      "--package": [true, "pnpm.io/cli/dlx"],
      "--allow-build": [true, "pnpm.io/cli/dlx"],
      "--reporter": [true, "pnpm help dlx: `--reporter append-only`"],
      "--shell-mode": [false, "pnpm help dlx"],
      "--silent": [false, "pnpm help dlx"],
    },
  },
  {
    key: "npm exec",
    tool: "npm",
    method: "echo-hit",
    versionArgs: ["--version"],
    helpArgs: [["exec", "--help"]],
    extraNames: npmNames,
    letters: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    argv: (t, v) => [t, ...(v === undefined ? [] : [v]), "exec", "--offline", "-c", "echo HIT"],
    exits: new Set([...EXIT_EARLY, "--versions", "--usage"]),
    // `npm exec --help`: `[--package <package-spec> ...] [-c|--call <call>] [-w|--workspace <workspace-name> ...] [--workspaces]`; npm help config: script-shell is a path.
    manual: {
      "--workspace": [true, "npm exec --help"],
      "--workspaces": [false, "npm exec --help"],
      "--script-shell": [true, "npm help config"],
      "-H": [false, "npm help (shorthand for --help)"],
    },
  },
  {
    // npx is its own binary: it rewrites `-p` to `--package` (valued), where `npm exec -p` is `--parseable`. Only the options it reads itself are probed;
    // every other option is npm's, recorded under `npm exec`.
    key: "npx",
    tool: "npx",
    method: "echo-hit",
    valuedOnly: true,
    versionArgs: ["--version"],
    helpArgs: [["--help"]],
    extraNames: async () => ["--package", "--call", "--workspace", "--yes", "--node-arg"],
    letters: "pcnywq",
    argv: (t, v) => [t, ...(v === undefined ? [] : [v]), "--offline", "-c", "echo HIT"],
    exits: new Set([...EXIT_EARLY, "--versions", "--usage"]),
    // `npm exec --help`: `[--package <package-spec> ...] [-c|--call <call>] [-w|--workspace <workspace-name> ...] [--workspaces]`; npm help config: script-shell is a path.
    manual: {
      "--workspace": [true, "npm exec --help"],
      "--workspaces": [false, "npm exec --help"],
      "--script-shell": [true, "npm help config"],
      "-H": [false, "npm help (shorthand for --help)"],
    },
  },
  {
    // env's short options (`wrapper-specs.ts`): the probe is `env OPT VALUE /bin/echo HIT`. The long options are GNU coreutils' and BSD env rejects or
    // ignores them, so only the letters are probed (the GNU names are listed in the table with that reason).
    key: "env",
    tool: "env",
    method: "echo-hit",
    flavour: true,
    versionArgs: ["--version"],
    helpArgs: [],
    letters: "i0vuCSPahx",
    argv: (t, v) => [t, ...(v === undefined ? [] : [v]), "/bin/echo", "HIT"],
    exits: new Set<string>(),
    rejects: /illegal option|invalid option|unrecognized option/,
    // `-S STRING` is a command line, so no value makes `/bin/echo HIT` the next word: documented in env(1).
    manual: {
      "-S": [true, "env(1): -S string"],
      "--split-string": [true, "env(1): --split-string=S"],
    },
  },
  ...(["run", "exec"] as const).map(
    (sub): Target => ({
      key: `docker ${sub}`,
      tool: "docker",
      helpMarksFlags: true,
      method: "flag-needs-argument",
      versionArgs: ["--version"],
      helpArgs: [[sub, "--help"]],
      argv: (t) => [...DOCKER_H, sub, t],
      rejects: /unknown (?:shorthand )?flag/,
    }),
  ),
  ...(["run", "exec"] as const).map(
    (sub): Target => ({
      key: `docker compose ${sub}`,
      tool: "docker",
      helpMarksFlags: true,
      method: "flag-needs-argument",
      versionArgs: ["--version"],
      helpArgs: [["compose", sub, "--help"]],
      argv: (t) => ["compose", sub, t],
      rejects: /unknown (?:shorthand )?flag/,
    }),
  ),
  ...(["run", "exec"] as const).map(
    (sub): Target => ({
      key: `podman ${sub}`,
      tool: "podman",
      helpMarksFlags: true,
      method: "flag-needs-argument",
      versionArgs: ["--version"],
      helpArgs: [[sub, "--help"]],
      argv: (t) => [sub, t],
      rejects: /unknown (?:shorthand )?flag/,
    }),
  ),
];

// ---------------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------------

/** The version number out of `--version` output (`1.4.4`, `Docker version 29.9.3, build x`, `podman version 5.8.0`). */
export const versionOf = (text: string): string =>
  /(\d+\.\d+(?:\.\d+)?)/.exec(text.trim())?.[1] ?? "unknown";

/** BSD env (macOS) has no `--version`; GNU env prints one: the flavour stands for the version of a tool without one. */
const flavourOf = (text: string): string =>
  /GNU coreutils/.test(text) ? `gnu-${versionOf(text)}` : "bsd";

type Probed = TakesValue | "rejected";

/** The echo-HIT probe: the separate form of a valued option consumes the word, a flag does not. */
async function probeHit(bin: string, target: Target, token: string, box: Sandbox): Promise<Probed> {
  const flagRun = await run(bin, target.argv(token), box);
  if (target.rejects?.test(flagRun.err) === true) return "rejected";
  // `valuedOnly`: only the separate-value run counts, with a stray word after it that a flag would have to treat as the command.
  const flagHit = target.valuedOnly === true ? false : /^HIT$/m.test(flagRun.out);
  // A flag runs the command without a value: one valued run shows whether the word is consumed anyway. A name that did not run
  // may need a value of a certain shape (a port, a mode), so every candidate value is tried.
  const values = target.values ?? DEFAULT_VALUES;
  for (const value of flagHit ? values.slice(0, 1) : values) {
    const valued = await run(bin, target.argv(token, value), box);
    if (/^HIT$/m.test(valued.out)) return flagHit ? "optional" : true;
  }
  return flagHit || target.valuedOnly === true ? false : "unverified";
}

/** The pflag probe: a valued option with nothing after it is `flag needs an argument`. */
async function probeArgument(
  bin: string,
  target: Target,
  token: string,
  box: Sandbox,
): Promise<Probed> {
  const { err } = await run(bin, target.argv(token), box);
  if (target.rejects?.test(err) === true) return "rejected";
  return /needs an argument/.test(err);
}

async function probe(bin: string, target: Target, token: string, box: Sandbox): Promise<Probed> {
  if (target.skip?.has(token) === true) return "unverified";
  if (target.exits?.has(token) === true) return false;
  return target.method === "flag-needs-argument"
    ? probeArgument(bin, target, token, box)
    : probeHit(bin, target, token, box);
}

/**
 * The documentation (`manual`) wins where a target lists an option (a probe cannot reach it: it needs a workspace or a package to install);
 * otherwise a probe that settled the option wins; otherwise a help placeholder says valued, and a name
 * WITHOUT one says flag only for a tool whose help marks every valued option (`helpMarksFlags`); the rest is `unverified` (pnpm's help
 * leaves `--package` and `--resume-from` bare).
 */
const settle = (
  probed: Probed,
  helpValue: boolean | undefined,
  helpMarksFlags: boolean,
  manual: boolean | undefined,
): { takesValue: TakesValue; evidence: Evidence } => {
  if (manual !== undefined) return { takesValue: manual, evidence: "help" };
  if (probed !== "unverified" && probed !== "rejected")
    return { takesValue: probed, evidence: "probe" };
  if (helpValue === true || (helpValue === false && helpMarksFlags))
    return { takesValue: helpValue, evidence: "help" };
  return { takesValue: "unverified", evidence: "unverified" };
};

/** The documented answer for an option no probe settled. */
const documented = (target: Target, name: string): boolean | undefined =>
  target.manual?.[name]?.[0];

/** Read the installed tool's options for one target. `only` limits the names probed (the live test's sample). */
export async function recordTarget(
  bin: string,
  target: Target,
  only?: ReadonlySet<string>,
): Promise<ToolFixture> {
  const box = makeSandbox(bin);
  try {
    const printed = await run(bin, target.versionArgs, box);
    const version =
      target.flavour === true ? flavourOf(`${printed.out}${printed.err}`) : versionOf(printed.out);
    const helps = await Promise.all(target.helpArgs.map((args) => run(bin, args, box)));
    const fromHelp = candidatesOf(...helps.map((h) => `${h.out}\n${h.err}`));
    const extra = (await target.extraNames?.(bin, box)) ?? [];
    const letters = [...(target.letters ?? "")].map((l) => `-${l}`);
    const known = new Set(
      fromHelp.flatMap((c) => (c.short === undefined ? [c.name] : [c.name, c.short])),
    );
    const universe: Candidate[] = [
      ...fromHelp,
      ...[...new Set([...extra, ...letters])]
        .filter((n) => !known.has(n))
        .map((name) => ({ name })),
    ].filter((c) => only === undefined || only.has(c.name));
    const options: RecordedOption[] = [];
    const rejected: string[] = [];
    if (target.method === "help") {
      for (const c of universe) {
        const settled = settle(
          "unverified",
          c.helpValue,
          target.helpMarksFlags === true,
          documented(target, c.name),
        );
        options.push({
          name: c.name,
          ...(c.short === undefined ? {} : { short: c.short }),
          ...settled,
        });
      }
    } else {
      const results = await pool(universe, async (c) => ({
        c,
        probed: await probe(bin, target, c.name, box),
      }));
      for (const { c, probed } of results) {
        if (probed === "rejected") {
          rejected.push(c.name);
          continue;
        }
        const { takesValue, evidence } = settle(
          probed,
          c.helpValue,
          target.helpMarksFlags === true,
          documented(target, c.name),
        );
        options.push({
          name: c.name,
          ...(c.short === undefined ? {} : { short: c.short }),
          takesValue,
          evidence,
        });
      }
    }
    options.sort((a, b) => a.name.localeCompare(b.name));
    const commands = await target.commands?.(bin, box);
    return {
      tool: target.tool,
      version,
      command: target.key,
      method: target.method,
      options,
      rejected: rejected.sort(),
      ...(commands === undefined ? {} : { commands }),
    };
  } finally {
    box.dispose();
  }
}

/** The file name of a fixture. */
export const fixtureName = (fixture: Pick<ToolFixture, "command" | "version">): string =>
  `${fixture.command.replace(/\s+/g, "-")}.${fixture.version}.json`;

// ---------------------------------------------------------------------------------------------------
// The production-table words of a recording (pasted into the grammar of `runner-grammars.ts` once; the test keeps them honest)
// ---------------------------------------------------------------------------------------------------

export function grammarWords(fixture: ToolFixture): Record<string, string> {
  const shorts = (valued: boolean | "optional"): string =>
    fixture.options
      .filter(
        (o) =>
          (o.short ?? (/^-[^-]$/.test(o.name) ? o.name : undefined)) !== undefined &&
          o.takesValue === valued,
      )
      .map((o) => (o.short ?? o.name).slice(1))
      .join("");
  const longs = (valued: boolean | "optional" | "unverified"): string =>
    fixture.options
      .filter((o) => o.name.startsWith("--") && o.takesValue === valued)
      .map((o) => o.name.slice(2))
      .join(" ");
  return {
    flags: shorts(false),
    values: shorts(true),
    longFlags: longs(false),
    longValues: longs(true),
    longOptional: longs("optional"),
    longUnverified: longs("unverified"),
  };
}

// ---------------------------------------------------------------------------------------------------
// CLI: `bun scripts/__tests__/helpers/record-tool-options.ts [--write] [--print] [key ...]`
// ---------------------------------------------------------------------------------------------------

async function main(args: readonly string[]): Promise<void> {
  const write = args.includes("--write");
  const print = args.includes("--print");
  const keys = args.filter((a) => !a.startsWith("--"));
  const chosen = TARGETS.filter((t) => keys.length === 0 || keys.includes(t.key));
  const dir = join(
    dirname(new URL(import.meta.url).pathname),
    "..",
    "fixtures",
    "harness-tool-options",
  );
  for (const target of chosen) {
    const bin = findTool(target.tool);
    if (bin === undefined) {
      console.log(`${target.key}: ${target.tool} is not installed, nothing recorded`);
      continue;
    }
    const fixture = await recordTarget(bin, target);
    const counts = new Map<string, number>();
    for (const o of fixture.options)
      counts.set(String(o.takesValue), (counts.get(String(o.takesValue)) ?? 0) + 1);
    console.log(
      `${target.key} ${fixture.version}: ${fixture.options.length} options ${JSON.stringify([...counts])}, ${fixture.rejected.length} rejected`,
    );
    if (write) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, fixtureName(fixture)), `${JSON.stringify(fixture, null, 2)}\n`);
    }
    if (print) console.log(JSON.stringify(grammarWords(fixture), null, 2));
  }
}

if (process.argv[1]?.endsWith("record-tool-options.ts") === true) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

/** `execFileSync` of `--version`, for a test that wants the installed version without recording. */
export const installedVersion = (bin: string, args: readonly string[] = ["--version"]): string =>
  versionOf(execFileSync(bin, [...args], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }));
