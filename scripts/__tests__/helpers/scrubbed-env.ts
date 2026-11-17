/**
 * Wave 12, G-3 (R9-COMP-10): the environment a harness test hands to a REAL third-party tool it runs (libpq's
 * `pg_isready`, `git`). Inheriting the developer's environment lets it read what the test did not mean to read or change:
 * `PGHOSTADDR`, `PGSERVICE`, `PGPASSFILE` reach libpq; `GIT_DIR`, `GIT_INDEX_FILE` (set when a test run is started from
 * a git hook) point a `git init`, `git add` or `git commit` meant for a temp repository at the REAL one; `~/.gitconfig`
 * (`commit.gpgsign`, `init.templateDir`, `core.hooksPath`) changes what a commit does. The recorders of `helpers/` already
 * run their probes this way. Nothing here is for the guard under test: its own seams (`CW_HARNESS_*`) are set per test.
 */

/** `PATH` (to find the tool), a scratch `HOME` (no service, password or git configuration in it), `LANG=C`, and `extra`. */
export function scrubbedToolEnv(
  home: string,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { PATH: process.env.PATH ?? "", HOME: home, LANG: "C", ...extra };
}

/** For git: also no system configuration and no global one, whatever `HOME` holds. */
export function scrubbedGitEnv(home: string): Record<string, string> {
  return scrubbedToolEnv(home, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
}

/**
 * `parent` without the switches of the guard that a developer sets by hand to get a session back or to point it
 * elsewhere (`CW_HARNESS_FAIL_OPEN=1` makes every deny an allow): a test that expects a deny must not inherit them.
 * A test that wants one passes it explicitly, after this.
 */
export const GUARD_SWITCHES: readonly string[] = [
  "CW_HARNESS_FAIL_OPEN",
  "CW_HARNESS_TEST_FAULT",
  "CW_HARNESS_TEST_LEDGER_FAULT",
  "CW_HARNESS_DEADLINE_MS_FOR_TESTS",
  "CW_HARNESS_ROOT_FOR_TESTS",
];

export function withoutGuardSwitches(parent: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(parent).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !GUARD_SWITCHES.includes(entry[0]),
    ),
  );
}
