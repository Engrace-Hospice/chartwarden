/**
 * The option grammars of the package runners (wave 10, A8/A9; round-7 R7-ADV-13, R7-CR-8, R7-CR-13). Wave 8 read the options of ALL
 * package managers with one regex (`MANAGER_VALUED`) that listed `-r -c -w -F -C` as value options, which are flags in pnpm and
 * yarn (`pnpm -r exec CMD` ate `exec` and ran the next word as the subcommand), and wave 9 listed booleans as valued
 * (`env-cmd --fallback`, `lerna exec --include-dependencies`, `nx exec --parallel`, `op run --cache`). Each tool now has the grammar of
 * its own CLI, read by `option-grammar.ts`: bun's from its installed `--help` (every long option is a flag, a value rides after `=`:
 * `bun --port 3000 run x` is a usage error, probed on bun 1.4.4), pnpm's from `pnpm help exec|dlx` (installed, v10), uv's from `uv run|
 * tool run|uvx --help` (installed); npm's, yarn's and the environment loaders' from their documentation, marked `lax` (an unknown
 * option is a flag, as npm's own parser reads it) and `unverified` where the tool is not installed here. Pure.
 */
import type { OptionGrammar } from "./option-grammar";

const grammar = (g: Partial<OptionGrammar>): OptionGrammar => ({
  flags: "",
  values: "",
  longFlags: [],
  longValues: [],
  ...g,
});

const words = (list: string): string[] => list.split(" ");

/** Commander-style tools: a value option does not take a dash word, and an unknown option is a flag. */
const loose = (g: Partial<OptionGrammar>): OptionGrammar =>
  grammar({ lax: true, softValues: true, ...g });

// ---------------------------------------------------------------------------------------------------
// bun (1.4.4: `bun --help`, `bun x --help`)
// ---------------------------------------------------------------------------------------------------

/** Every long option of `bun --help`: a flag whose value, when it has one, rides after `=`. */
const BUN_LONG: readonly string[] = words(
  "bun check cpu-prof cpu-prof-md experimental-http2-fetch experimental-http3-fetch experimental-stream-iter expose-gc heap-prof heap-prof-md help hot if-present ignore-dce-annotations insecure-http-parser interactive jsx-side-effects no-addons no-clear-screen no-deprecation no-env-file no-exit-on-error no-ffi-cc no-install no-macros no-orphans no-warnings parallel pending-deprecation prefer-latest prefer-offline preserve-symlinks preserve-symlinks-main redis-preconnect revision sequential silent smol sql-preconnect throw-deprecation trace-deprecation trace-warnings use-bundled-ca use-openssl-ca use-system-ca version watch workspaces zero-fill-buffers tls-min-v1.0 tls-min-v1.1 tls-min-v1.2 tls-min-v1.3 tls-max-v1.2 tls-max-v1.3 conditions config console-depth cpu-prof-dir cpu-prof-interval cpu-prof-name cron-period cron-title cwd define disable-warning dns-result-order drop elide-lines env-file eval extension-order feature fetch-preconnect filter heap-prof-dir heap-prof-interval heap-prof-name import inspect inspect-brk inspect-wait install jsx-factory jsx-fragment jsx-import-source jsx-runtime loader main-fields max-http-header-size port preload print redirect-warnings require shell title tsconfig-override unhandled-rejections user-agent watch-kill-signal",
);
/** bun, before and after `run`: no abbreviation, an unknown option is reported. */
export const BUN: OptionGrammar = grammar({
  exact: true,
  flags: "bhiv",
  values: "Fcdelpr",
  longFlags: BUN_LONG,
});
/** `bun x [flags] <package>`: bunx's own. */
export const BUNX: OptionGrammar = loose({
  flags: "b",
  values: "p",
  longFlags: words("bun ignore-scripts no-install silent trust verbose help"),
  longValues: words("package registry cwd env-file minimum-release-age ca cafile"),
});

// ---------------------------------------------------------------------------------------------------
// pnpm (10.30: `pnpm help exec`, `pnpm help dlx`), npm, yarn
// ---------------------------------------------------------------------------------------------------

/** pnpm: `-r -w -s -c` are flags (`--recursive`, `--workspace-root`, `--silent`, `--shell-mode`); `-C` and `-F` take a value. */
export const PNPM: OptionGrammar = loose({
  flags: "rwschv",
  values: "CFp",
  longFlags: words(
    "recursive workspace-root silent shell-mode help version color no-color aggregate-output parallel report-summary stream use-stderr no-reporter-hide-prefix bail no-bail sort no-sort reverse if-present include-workspace-root fail-if-no-match",
  ),
  longValues: words(
    "dir filter filter-prod workspace-concurrency reporter loglevel registry resume-from package allow-build test-pattern changed-files-ignore-pattern",
  ),
});

/** npm and npx: `-w NAME` is a value, `--workspaces` a flag; an unknown option is a boolean, as nopt reads it. */
export const NPM: OptionGrammar = loose({
  flags: "yhvs",
  values: "pwcC",
  longFlags: words(
    "yes no silent include-workspace-root workspaces ignore-scripts legacy-peer-deps json help version verbose",
  ),
  longValues: words(
    "package call workspace prefix cache userconfig globalconfig registry loglevel node-arg before",
  ),
});

/** yarn (unverified here): `-w -r -c -s` are flags; `--cwd` and a few more take a value. */
export const YARN: OptionGrammar = loose({
  flags: "wrcshv",
  values: "p",
  longFlags: words("silent verbose json no-progress offline prefer-offline help version quiet"),
  longValues: words(
    "cwd package registry network-timeout proxy https-proxy modules-folder cache-folder mutex",
  ),
});

/** `yarn workspaces foreach [options] CMD` (berry; unverified here). */
export const YARN_FOREACH: OptionGrammar = loose({
  flags: "ARpitvWn",
  values: "j",
  longFlags: words(
    "all recursive parallel interlaced verbose topological topological-dev worktree dry-run no-private exclude-private",
  ),
  longValues: words("jobs include exclude from since"),
});

// ---------------------------------------------------------------------------------------------------
// The environment loaders and version managers (documentation; unverified here)
// ---------------------------------------------------------------------------------------------------

export const VOLTA: OptionGrammar = loose({
  longFlags: words("bundled-npm help"),
  longValues: words("node npm yarn pnpm env"),
});
export const MISE: OptionGrammar = loose({
  values: "CEjc",
  longValues: words("cd env jobs command"),
});
export const ASDF: OptionGrammar = loose({});
export const DIRENV: OptionGrammar = loose({});
export const DOTENV: OptionGrammar = loose({
  flags: "o",
  values: "evpc",
  longFlags: words("override"),
  longValues: words("env variable cascade"),
});
export const DOTENVX: OptionGrammar = loose({
  flags: "oqv",
  values: "fe",
  wordValues: ["-fk"],
  longFlags: words("overload strict quiet verbose debug"),
  longValues: words("env-file env-keys-file env convention log-level ignore"),
});
/** env-cmd: `--fallback`, `--no-override`, `--use-shell`, `--silent`, `-x` are flags (wave 9 listed `--fallback` as valued). */
export const ENV_CMD: OptionGrammar = loose({
  flags: "x",
  values: "fre",
  longFlags: words("fallback no-override use-shell silent expand-envs"),
  longValues: words("file rc-file environments"),
});
export const DOPPLER: OptionGrammar = loose({
  values: "pct",
  longValues: words(
    "project config token mount mount-format mount-max-reads name-transformer fallback scope api-host config-dir log-level dynamic-ttl metadata-path command",
  ),
});
/** op run: `--cache` and `--no-masking` are flags (wave 9 listed `--cache` as valued). */
export const OP: OptionGrammar = loose({
  longFlags: words("cache no-masking"),
  longValues: words("env-file environment account vault session config encoding"),
});
/** lerna exec: `--include-dependencies` and the other `--include-*`, `--no-*` words are flags. */
export const LERNA: OptionGrammar = loose({
  longFlags: words(
    "include-dependencies include-dependents include-merged-tags no-bail no-prefix no-sort parallel stream profile reject-cycles bail",
  ),
  longValues: words("scope ignore since concurrency log-level loglevel profile-location"),
});
/** nx exec: `--parallel` is a flag here (wave 9 listed it as valued). */
export const NX: OptionGrammar = loose({
  values: "pc",
  longFlags: words("parallel verbose skip-nx-cache"),
  longValues: words("projects exclude configuration"),
});

// ---------------------------------------------------------------------------------------------------
// Python and Nix runners (wave 10, A9)
// ---------------------------------------------------------------------------------------------------

/** `uv run --help` (uv installed here): exact long names, an unknown option is reported. */
export const UV_RUN: OptionGrammar = grammar({
  exact: true,
  flags: "Uhmnqsv",
  values: "CPfipw",
  longFlags: words(
    "active all-extras all-groups all-packages compile-bytecode exact frozen gui-script help isolated locked managed-python module native-tls no-binary no-build no-build-isolation no-cache no-config no-default-groups no-dev no-editable no-env-file no-index no-managed-python no-progress no-project no-python-downloads no-sources no-sync offline only-dev quiet refresh reinstall script upgrade verbose version",
  ),
  longValues: words(
    "allow-insecure-host cache-dir color config-file config-setting config-settings-package default-index directory env-file exclude-newer exclude-newer-package extra extra-index-url find-links fork-strategy group index index-strategy index-url keyring-provider link-mode no-binary-package no-build-isolation-package no-build-package no-extra no-group only-group package prerelease project python python-platform refresh-package reinstall-package resolution upgrade-package with with-editable with-requirements",
  ),
});
/** `uvx --help` and `uv tool run --help` (uv installed here). */
export const UVX: OptionGrammar = grammar({
  exact: true,
  flags: "UVhnqv",
  values: "CPbcfipw",
  longFlags: words(
    "compile-bytecode help isolated managed-python native-tls no-binary no-build no-build-isolation no-cache no-config no-env-file no-index no-managed-python no-progress no-python-downloads no-sources offline quiet refresh reinstall upgrade verbose version",
  ),
  longValues: words(
    "allow-insecure-host build-constraints cache-dir color config-file config-setting config-settings-package constraints default-index directory env-file exclude-newer exclude-newer-package extra-index-url find-links fork-strategy from index index-strategy index-url keyring-provider link-mode no-binary-package no-build-isolation-package no-build-package overrides prerelease project python python-platform refresh-package reinstall-package resolution upgrade-package with with-editable with-requirements",
  ),
});
/** `pipx run`, `poetry run`, `pdm run`, `rye run`, `hatch run`, `pipenv run`, `conda run`, `micromamba run`, `devbox run`, `flox activate`. */
export const PIPX: OptionGrammar = loose({
  flags: "v",
  values: "",
  longFlags: words("no-cache verbose quiet"),
  longValues: words("spec python pip-args index-url"),
});
export const CONDA: OptionGrammar = loose({
  flags: "v",
  values: "npr",
  longFlags: words("no-capture-output verbose live-stream debug-wrapper-scripts"),
  longValues: words("name prefix cwd"),
});
export const PLAIN_RUN: OptionGrammar = loose({});
/** flox activate: `-c, --command CMD` hands a string to a shell (unverified here). */
export const FLOX: OptionGrammar = loose({ values: "cd", longValues: words("command dir") });
export const NIX: OptionGrammar = loose({
  values: "ceI",
  longFlags: words("impure ignore-environment keep-env-var pure"),
  longValues: words("command run keep unset override-input extra-experimental-features option"),
});

/** perf stat|record|trace [options] [--] COMMAND (unverified here). */
export const PERF: OptionGrammar = loose({
  flags: "adBvSgnR",
  values: "eCpoIDFGrtmcAsT",
  longValues: words("event cpu pid output interval-print delay cgroup repeat"),
});
