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
  grammar({ lax: true, softValues: true, unlistedLettersAsk: true, ...g });

// ---------------------------------------------------------------------------------------------------
// bun (1.4.4), pnpm (10.30), npm and npx (11.11): RECORDED from the installed tools (wave 11, rule 12; round-8 R8-ADV-2, R8-ADV-3, R8-ADV-11)
// ---------------------------------------------------------------------------------------------------
// Wave 10 wrote these from memory and was wrong about the real tools three times (`bun run --cwd x CMD`, `pnpm --prefix x exec CMD`, npm's
// ~90 value options): a valued option declared as a flag lets its value stand for the command. The names below are what
// `scripts/__tests__/helpers/record-tool-options.ts` read from the installed tool (a probe `TOOL OPT VALUE echo HIT` against `TOOL OPT echo
// HIT`, the fixtures under `scripts/__tests__/fixtures/harness-tool-options/`), and `harness-tool-options-wave11.test.ts` fails when a
// recorded valued option is read as a flag, a recorded flag as a valued option, or (for a strict table) a recorded option is missing. An
// option the probe could not settle is `unverified` in the fixture and is left OUT of a lax table, where an unlisted `--name` followed by a
// bare word asks (`option-grammar.ts`); an option the tool does not know is reported by a strict table.

/**
 * The subcommands of bun (`bun --help`, bun 1.4.4: the Commands block and its `(bun x)` aliases), npm (`npm help`, npm 11.11: the command list; the
 * aliases are npm's own alias table, from its source, unverified here) and yarn (classic and berry, unverified: not installed). A word in one of these
 * is no program: an unlisted option before it is a flag (`option-grammar.ts`, `subcommands`; wave 12, E1-4).
 */
export const BUN_COMMANDS: readonly string[] = words(
  "x run test build install i add a remove rm update upgrade link unlink pm init create c repl outdated publish audit info patch why exec completions help fmt check dedupe prune dev",
);
export const NPM_COMMANDS: readonly string[] = words(
  "access adduser audit bugs cache ci completion config dedupe deprecate diff dist-tag docs doctor edit exec explain explore find-dupes fund get help help-search init install install-ci-test install-test link ll login logout ls org outdated owner pack ping pkg prefix profile prune publish query rebuild repo restart root run run-script sbom search set shrinkwrap star stars start stop team test token undeprecate unpublish unstar update version view whoami trust " +
    "author home issues info show find add unlink remove rm r rb list ln create i it cit up c s se tst t ddp v run clean-install clean-install-test why la verison ic innit in ins inst insta instal isnt isnta isntal isntall install-clean isntall-clean hlep dist-tags upgrade udpate rum sit urn ogr x uninstall un",
);
export const YARN_COMMANDS: readonly string[] = words(
  "add bin cache config constraints dedupe dlx exec explain info init install link node npm pack patch plugin rebuild remove run set stage unlink unplug up upgrade version why workspace workspaces global help install-peerdeps import generate-lock-entry licenses outdated owner policies publish tag team test login logout list check autoclean",
);

/**
 * `bun [options] COMMAND`: the options before the subcommand. bun reads a value after `=`; a separate value after a valued option is read
 * (`bun --cwd x run y` prints bun's usage and runs nothing, probed), so the guard reads the same words either way. No abbreviation.
 */
export const BUN_GLOBAL: OptionGrammar = grammar({
  exact: true,
  // bun reads an unknown option before the subcommand as a flag (`bun --zz-unknown run x` runs `run`, `bun --frozen-lockfile install` is install's own
  // option: probed on bun 1.4.4), so the table is lax; a bare word that is no subcommand after one still asks
  lax: true,
  unlistedLettersAsk: true,
  subcommands: [...BUN_COMMANDS, "run"],
  flags: "bchvi",
  values: "deFlrp",
  longFlags: words(
    "bun check config cpu-prof cpu-prof-md experimental-http2-fetch experimental-http3-fetch experimental-stream-iter expose-gc heap-prof heap-prof-md help hot if-present ignore-dce-annotations insecure-http-parser inspect inspect-brk inspect-wait interactive jsx-side-effects no-addons no-clear-screen no-deprecation no-env-file no-exit-on-error no-ffi-cc no-install no-macros no-orphans no-warnings parallel pending-deprecation prefer-latest prefer-offline preserve-symlinks preserve-symlinks-main redis-preconnect revision sequential silent smol sql-preconnect throw-deprecation tls-max-v1.2 tls-max-v1.3 tls-min-v1.0 tls-min-v1.1 tls-min-v1.2 tls-min-v1.3 trace-deprecation trace-warnings use-bundled-ca use-openssl-ca use-system-ca version watch workspaces zero-fill-buffers",
  ),
  longValues: words(
    "conditions console-depth cpu-prof-dir cpu-prof-interval cpu-prof-name cron-period cron-title cwd define disable-warning dns-result-order drop elide-lines env-file eval extension-order feature fetch-preconnect filter heap-prof-dir heap-prof-interval heap-prof-name import install jsx-factory jsx-fragment jsx-import-source jsx-runtime loader main-fields max-http-header-size port preload print redirect-warnings require shell title tsconfig-override unhandled-rejections user-agent watch-kill-signal",
  ),
});

/**
 * `bun run [options] <file or script>`: a valued option takes the NEXT word (`bun run --cwd x CMD` runs CMD, `--env-file`, `--elide-lines`,
 * `--preload`, `--shell`, `--install`, `--port`, `--define`, `--loader`, `-r`, `-d`, `-l`, `-F`, `-e`, `-p`); `--config` and `-c` take their
 * value only after `=` (`bun run -c x CMD` treats x as the script), as do `--inspect*`, so they are flags here. No abbreviation.
 */
export const BUN_RUN: OptionGrammar = grammar({
  exact: true,
  flags: "bchi",
  values: "deFlrp",
  longFlags: words(
    "bun check config cpu-prof cpu-prof-md experimental-http2-fetch experimental-http3-fetch experimental-stream-iter expose-gc heap-prof heap-prof-md help hot if-present ignore-dce-annotations insecure-http-parser inspect inspect-brk inspect-wait interactive jsx-side-effects no-addons no-clear-screen no-deprecation no-env-file no-exit-on-error no-ffi-cc no-install no-macros no-orphans no-warnings parallel pending-deprecation prefer-latest prefer-offline preserve-symlinks preserve-symlinks-main redis-preconnect sequential silent smol sql-preconnect throw-deprecation tls-max-v1.2 tls-max-v1.3 tls-min-v1.0 tls-min-v1.1 tls-min-v1.2 tls-min-v1.3 trace-deprecation trace-warnings use-bundled-ca use-openssl-ca use-system-ca watch workspaces zero-fill-buffers",
  ),
  longValues: words(
    "conditions console-depth cpu-prof-dir cpu-prof-interval cpu-prof-name cron-period cron-title cwd define disable-warning dns-result-order drop elide-lines env-file eval extension-order feature fetch-preconnect filter heap-prof-dir heap-prof-interval heap-prof-name import install jsx-factory jsx-fragment jsx-import-source jsx-runtime loader main-fields max-http-header-size port preload print redirect-warnings require shell title tsconfig-override unhandled-rejections user-agent watch-kill-signal",
  ),
});

/** `bun x [flags] <package>`: bunx's own (`bun x --help`: help text only, a flag would make the next word a package to install). */
export const BUNX: OptionGrammar = loose({
  flags: "b",
  values: "p",
  longFlags: words("bun ignore-scripts no-install silent trust verbose help"),
  longValues: words("package registry cwd env-file minimum-release-age ca cafile"),
});

/**
 * The commands pnpm runs itself (`pnpm help -a`, recorded in the `pnpm` fixture: the first group), then the aliases and the commands it
 * hands to npm that `help -a` does not list (unverified: from the documentation). Any other first word is a PATH program that pnpm runs
 * as `pnpm exec WORD` (`pnpm echo HIT` prints HIT on pnpm 10.30), unless it names a script of the package.
 */
export const PNPM_COMMANDS: ReadonlySet<string> = new Set([
  ...words(
    "add approve-builds audit bin c cache cat-file cat-index config create dedupe deploy dlx doctor env exec fetch find-hash i ignored-builds import init install install-test it licenses link list ln ls outdated pack patch patch-commit patch-remove prune publish rb rebuild remove rm root run self-update start store t test unlink up update why",
  ),
  ...words(
    "recursive m multi uninstall un upgrade ll la server setup completion help access adduser bugs deprecate dist-tag docs edit info login logout owner ping prefix profile pkg repo restart search set star stars stop team token unpublish unstar version view whoami",
  ),
]);

/**
 * pnpm's options before the subcommand (`pnpm --prefix x exec CMD`, `pnpm -r exec CMD`, `pnpm --filter x exec CMD`). pnpm 10.30 reads
 * everything AFTER `exec` as the command (`pnpm exec -r echo HIT` runs a program named `-r`); the guard still reads options there, which
 * only makes it stricter. Lax: pnpm accepts every npm config name, and an option the fixture marks `unverified` (needs a workspace, or a
 * value of a certain shape) is left out so that `pnpm --name VALUE CMD` asks.
 */
export const PNPM: OptionGrammar = loose({
  flags: "hrcswdpqv",
  values: "CF",
  longFlags: words(
    "aggregate-output color fail-if-no-match help ignore-workspace include include-workspace-root no-bail no-color no-reporter-hide-prefix parallel parseable recursive report-summary reporter-hide-prefix reverse shell shell-mode silent sort stream unsafe-perm usage use-stderr version workspace-root",
  ),
  longValues: words(
    "changed-files-ignore-pattern child-concurrency dir fetch-retries fetch-retry-factor fetch-retry-maxtimeout fetch-retry-mintimeout fetch-timeout filter filter-prod hoist-pattern lockfile-dir loglevel modules-dir network-concurrency prefix public-hoist-pattern reporter save-catalog-name store-dir test-pattern trust-policy-exclude trust-policy-ignore-after virtual-store-dir workspace-concurrency workspace-packages",
  ),
  unverified: words(
    "all allow-build ca cache cache-dir cpu global-bin-dir global-dir global-pnpmfile https-proxy libc merge-git-branch-lockfiles-branch-pattern node-linker noproxy npm-path only os package package-import-method pnpmfile proxy registry resume-from save-catalog save-prefix trust-policy use-node-version which",
  ),
});

/** `pnpm dlx [options] <package>` (`pnpm help dlx`; the value placeholders are documented at pnpm.io/cli/dlx). */
export const PNPM_DLX: OptionGrammar = loose({
  flags: "cs",
  // pnpm 9 and older spell `--package` as `-p`; 10.30's help no longer lists it, and a valued reading is the safe one for a command after it.
  values: "p",
  longFlags: words("shell-mode silent"),
  longValues: words("allow-build package reporter"),
});

/**
 * `npm [options] exec|x ...`: the config names of `npm config ls -l` plus npm's shorthands, valued or flag as `npm exec --OPT VALUE -c
 * 'echo HIT'` shows (`-p` is `--parseable` here, a flag). An unknown option is a boolean in nopt, so the table is lax.
 */
export const NPM: OptionGrammar = loose({
  // npm warns `Unknown cli config` for any other letter: the recording keeps those as `rejected`, so an unlisted letter asks (R9-COMP-5)
  flags: "aBdDEfghHijlnOpPqsSvVy",
  values: "cwCekLm",
  longFlags: words(
    "all allow-same-version audit bin-links bypass-2fa color commit-hooks description dev diff-ignore-all-space diff-name-only diff-no-prefix diff-text dry-run engine-strict expect-results force foreground-scripts format-package-lock fund git-tag-version global global-style if-present ignore-scripts include-staged include-workspace-root init-private install-links json legacy-bundling legacy-peer-deps link long no npm-version offline omit-lockfile-registry-resolved optional package-lock package-lock-only packages-all parseable prefer-dedupe prefer-offline prefer-online production progress provenance read-only rebuild-bundle save save-bundle save-dev save-exact save-optional save-peer save-prod shrinkwrap sign-git-commit sign-git-tag strict-peer-deps strict-ssl timing unicode update-notifier usage version versions workspaces workspaces-update yes",
  ),
  longValues: words(
    "access allow-git also audit-level auth-type before browser ca cache cache-max cache-min cafile call cert cidr cpu depth diff diff-dst-prefix diff-src-prefix diff-unified editor expect-result-count expires fetch-retries fetch-retry-factor fetch-retry-maxtimeout fetch-retry-mintimeout fetch-timeout git globalconfig heading https-proxy include init-author-email init-author-name init-author-url init-license init-module init-type init-version install-strategy key libc local-address location lockfile-version loglevel logs-dir logs-max maxsockets message min-release-age name node-gyp node-options noproxy omit only orgs orgs-permission os otp pack-destination package packages packages-and-scopes-permission password prefix preid provenance-file proxy registry replace-registry-host save-prefix sbom-format sbom-type scope scopes script-shell searchexclude searchlimit searchopts searchstaleness shell tag tag-version-prefix token-description umask user-agent userconfig viewer which workspace",
  ),
});

/** `npx` is its own binary: it rewrites `-p` to `--package` and reads `-n` with a value; everything else is npm's. */
export const NPX: OptionGrammar = loose({
  flags: NPM.flags.replace(/[pn]/g, ""),
  values: `${NPM.values}pn`,
  // `--no-install` is npx's own legacy spelling of `--no` (49 distinct real commands use it); `npm config` has no such name
  longFlags: [...NPM.longFlags, "no-install"],
  longValues: [...NPM.longValues, "node-arg"],
});

/** yarn (unverified here): `-w -r -c -s` are flags; `--cwd` and a few more take a value. */
export const YARN: OptionGrammar = loose({
  flags: "wrcqshv",
  values: "p",
  longFlags: words("silent verbose json no-progress offline prefer-offline help version quiet"),
  longValues: words(
    "cwd package registry network-timeout proxy https-proxy modules-folder cache-folder mutex",
  ),
});

/**
 * The same tables read BEFORE the subcommand (`npm --no-fund install`): there a bare word that is one of the manager's own subcommands is no program, so an
 * unlisted option in front of it is a flag (E1-4). After `exec` or `dlx` the same word WOULD be a program, so the subcommand-less tables above read those.
 */
export const NPM_GLOBAL: OptionGrammar = { ...NPM, subcommands: NPM_COMMANDS };
export const PNPM_GLOBAL: OptionGrammar = { ...PNPM, subcommands: [...PNPM_COMMANDS] };
export const YARN_GLOBAL: OptionGrammar = { ...YARN, subcommands: YARN_COMMANDS };

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

// ---------------------------------------------------------------------------------------------------
// Command-string runners (wave 12, E1-6; R9-ADV-16). None is installed here: documentation, unverified, lax (an unlisted option before a word asks).
// ---------------------------------------------------------------------------------------------------

/** `concurrently [options] "cmd1" "cmd2"`: every operand is a shell line (`-n NAMES`, `-c COLORS`, `-p PREFIX`, `-m N`, `-k`, `-r`, `-s`, `--raw`, ...). */
export const CONCURRENTLY: OptionGrammar = loose({
  flags: "krsh",
  values: "ncpmlt",
  longFlags: words(
    "kill-others kill-others-on-fail raw no-color hide handle-input restart-tries success group timings passthrough-arguments help version",
  ),
  longValues: words(
    "names prefix-colors prefix prefix-length max-processes kill-signal restart-after timestamp-format teardown",
  ),
});
/** `nodemon [options] script.js`, `nodemon --exec 'CMD'`: only `-x`/`--exec` starts a command line (the script is run by node). */
export const NODEMON: OptionGrammar = loose({
  flags: "LVhIqvd",
  values: "xwieCs",
  longFlags: words(
    "verbose legacy-watch quiet dump no-update-notifier help version polling-interval",
  ),
  longValues: words("exec watch ignore ext delay signal cwd config on-change-only spawn"),
});
/** `watchexec [options] [--] COMMAND ARGS`: the words after the options are the command (one shell line unless `-n`). */
export const WATCHEXEC: OptionGrammar = loose({
  flags: "rnqvVhc",
  values: "wiEeFdpWo",
  longFlags: words(
    "restart no-shell quiet verbose version help clear postpone no-vcs-ignore no-project-ignore no-default-ignore no-global-ignore no-discover-ignore",
  ),
  longValues: words(
    "watch ignore env exts filter debounce shell signal stop-signal stop-timeout workdir",
  ),
});
