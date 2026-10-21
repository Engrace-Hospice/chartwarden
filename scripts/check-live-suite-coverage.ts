/**
 * ChartWarden — live-suite CI coverage gate (GAP-086, widened for #41)
 * ---------------------------------------------------------------------
 * Every live-database / live-Redis / browser suite in package.json must be RUN by a job in
 * `.github/workflows/ci.yml`, or be an EXPLICIT, reasoned deferral in {@link DEFERRED} below.
 *
 * This gate exists because the failure it catches is silent in both directions. A live suite is
 * `describe.skipIf(!CHARTWARDEN_TEST_DATABASE_URL)`, so with no database it reports as SKIPPED, not failed —
 * `bun run test` stays green whether the suite passes, would fail, or has rotted beyond running. And a
 * script in package.json looks wired to a reader; nothing distinguishes one a CI job invokes from one
 * nothing has ever run. That combination let 25 lifecycle suites — 205 assertions across the entire
 * clinical-core write path — sit unexecuted outside their authors' laptops until an audit went looking.
 * 23 of the 25 were red by the time anyone did.
 *
 * ── WHY THIS NO LONGER MATCHES ON THE SCRIPT NAME (#41) ──────────────────────────────────────────
 * The original gate recognised suites by NAME:
 *
 *     /^test:(m\d+:[a-z0-9][a-z0-9-]*:live|rls:live(:m\d+)?)$/
 *
 * whose middle segment allows hyphens but NOT colons — so any name with two middle segments slipped
 * through. Nine of ninety-two scripts were invisible to it and six ran in no CI job at all, including
 * `test:m6:t3|t4|t5:write:live` (24 tests / 97 assertions over M6's election-CTI, discharge/F2F/LOC and
 * compliance-window write lifecycles) and the entire 18-test Playwright suite with its six axe-core
 * WCAG scans — the repo's only automated accessibility coverage. That is GAP-086's exact failure mode,
 * in GAP-086's own module family, reintroduced through the pattern of the gate written to prevent it.
 * The old header even conceded it: "a name this pattern does NOT match is silently ignored by this
 * gate, which is the exact failure mode the gate exists for."
 *
 * So detection now derives from what a script RUNS, not what it is CALLED: a script whose command
 * names a `*.live.test.ts` / `*-live.test.ts` file, or invokes `playwright`, is a live suite whatever
 * its name. A new suite cannot hide behind a naming convention it never had to follow.
 *
 * The ci.yml check stays deliberately textual — it asserts the script NAME appears somewhere in the
 * workflow, without caring which job or how the matrix is shaped. That tolerates re-grouping matrix
 * rows freely while still failing the moment a new live suite ships with no runner.
 *
 * Usage: `bun run arch:live-suites` (wired into `arch:fitness`).
 */
import type { Dirent } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` is a Bun extension and is undefined under vitest's node runner, which imports
// this module directly (scripts/__tests__/check-live-suite-coverage.test.ts). `import.meta.url` is
// standard and resolves the same path in both.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A script COMMAND that runs a live suite: a live test file, or Playwright. Matching the command
 * rather than the script name is the whole point — see the header.
 */
const LIVE_COMMAND = /\.live\.test\.ts|-live\.test\.ts|\bplaywright\b/;

/**
 * The FILE half of the same shape (#59). `LIVE_COMMAND` above answers "does every live script have a
 * CI runner"; this answers "does every live suite FILE have a script at all". They are different
 * questions and only the first was ever asked, so a file that no script names was run by nothing —
 * not CI, not a hook, not `bun run test` (which never sets the live env vars). Twenty-nine files sat
 * there, 111 tests, several of them the only live proof of a seam `CLAUDE.md` cites by filename. One
 * of the twenty-nine — `m6-abac-scope-resolver` — was RED, broken for the length of a branch by a
 * fail-closed guard added in another module, with no gate anywhere able to say so.
 */
const LIVE_FILE = /(\.live|-live)\.test\.ts$/;

/** Where suites live. Anything outside these trees is not a test tree. */
const SUITE_ROOTS = ["apps", "packages", "scripts", "e2e"] as const;

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "coverage", ".turbo"]);

/**
 * Files that match {@link LIVE_FILE} but are deliberately not their own suite. Empty today, and kept
 * for the same reason as DEFERRED: an exclusion must be a name on a list somebody can read, never a
 * file that quietly fails to be found.
 */
const NOT_A_SUITE_FILE: ReadonlySet<string> = new Set<string>();

/**
 * Interactive developer modes, never a CI job: `playwright --ui` opens a GUI and blocks forever.
 * Listed by name so the exclusion is a decision on the record, not an accident of pattern matching.
 */
const INTERACTIVE_MODES = new Set(["test:e2e:ui"]);

/**
 * Suites that genuinely cannot run in CI yet, each with the reason and the issue that unblocks it.
 *
 * A deferral is NOT a way to silence the gate — it is the opposite. The repo's own rule for a control
 * whose inputs do not exist yet (`deviceAttestationValid`, packages/auth/src/abac/registry.ts) is to
 * express the gap as a REGISTERED thing that refuses and says why, never as an unregistered name,
 * because both refuse identically and only the first is distinguishable from a mistake. An entry here
 * is that registration: it appears in this file, in `arch:fitness` output, and in review.
 *
 * A deferral is also self-cleaning: once the script IS wired into ci.yml, this gate fails and tells
 * you to delete the entry, so a stale deferral cannot quietly outlive its reason.
 */
const DEFERRED: Readonly<Record<string, string>> = {
  // Empty on purpose, and the map stays. `test:e2e` was the entry that motivated it — the 18-test
  // Playwright suite with its six axe-core WCAG scans, unrunnable because `bun run db:reset` aborted
  // partway (#39) and 10 of the 18 specs were red against a since-redesigned screen (#56). Both
  // closed, the suite is 18/18, and the `e2e` job now runs it — so the entry is gone, exactly as the
  // stale-deferral check below demands. The next suite that genuinely cannot run yet registers here
  // rather than quietly failing to be wired.
};

export interface LiveScript {
  readonly name: string;
  readonly command: string;
}

/** Every `*.live.test.ts` / `*-live.test.ts` file under {@link SUITE_ROOTS}, repo-relative, sorted. */
export function liveFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    // `ReturnType<typeof readdirSync>` resolves to the NO-options overload (`string[]`), so
    // `entry.name` below did not type-check once this tree was compiled. `withFileTypes: true`
    // returns `Dirent[]`; name it.
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a root that does not exist in this checkout is not an error
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (LIVE_FILE.test(entry.name) && !NOT_A_SUITE_FILE.has(entry.name)) {
        found.push(relative(root, join(dir, entry.name)));
      }
    }
  };
  for (const suiteRoot of SUITE_ROOTS) walk(join(root, suiteRoot));
  return found.sort();
}

/**
 * Is this suite file named by any script command? Matched on the BASENAME: a command may reference
 * the file through any relative path, and two suites never share a basename in this repo.
 */
export function namedByAScript(file: string, commands: readonly string[]): boolean {
  const name = basename(file);
  return commands.some((command) => command.includes(name));
}

/** Every live/E2E script in package.json, interactive modes excluded. */
export function liveScripts(scripts: Record<string, string>): LiveScript[] {
  return Object.entries(scripts)
    .filter(([name, command]) => LIVE_COMMAND.test(command) && !INTERACTIVE_MODES.has(name))
    .map(([name, command]) => ({ name, command }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Is `name` invoked anywhere in the workflow? A shorter script name can be a prefix of a longer one
 * (`test:rls:live` vs `test:rls:live:m6`), so match on a word boundary — otherwise the baseline suite
 * would look covered by any of its per-module siblings.
 */
export function invokedInCi(name: string, ci: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![\\w:-])`).test(ci);
}

export interface CoverageReport {
  readonly live: readonly LiveScript[];
  /** Live suites no ci.yml job runs and no deferral explains — the GAP-086 failure. */
  readonly unwired: readonly string[];
  /** Deferred suites that ARE wired now — the deferral is stale and must be deleted. */
  readonly staleDeferrals: readonly string[];
  readonly deferred: readonly string[];
  /** Every live suite FILE found on disk. */
  readonly files: readonly string[];
  /** Suite files no package.json script names — run by nothing at all (#59). */
  readonly unscripted: readonly string[];
}

export function run(
  root = ROOT,
  // Injectable so both branches of the deferral rule stay under test while DEFERRED is empty. A
  // mechanism proven only by the entry that happens to be in it today is proven only until that
  // entry is retired — which is precisely what just happened to `test:e2e`.
  deferred: Readonly<Record<string, string>> = DEFERRED,
): CoverageReport {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
  const live = liveScripts(pkg.scripts);

  const commands = Object.values(pkg.scripts);
  const files = liveFiles(root);
  const unscripted = files.filter((file) => !namedByAScript(file, commands));

  const unwired: string[] = [];
  const staleDeferrals: string[] = [];
  for (const { name } of live) {
    const wired = invokedInCi(name, ci);
    const isDeferred = name in deferred;
    if (isDeferred && wired) staleDeferrals.push(name);
    else if (!isDeferred && !wired) unwired.push(name);
  }
  return {
    live,
    unwired,
    staleDeferrals,
    deferred: Object.keys(deferred).sort(),
    files,
    unscripted,
  };
}

function main(): void {
  const { live, unwired, staleDeferrals, deferred, files, unscripted } = run();

  // Guard on the guard: if the detection above ever stops matching, this gate would pass vacuously
  // on an empty set — the very outcome it exists to prevent. The corpus is ~90 live scripts; a
  // collapse to a handful means the matcher broke, not that the suites were deleted.
  if (live.length < 50) {
    console.error(
      `FAIL check-live-suite-coverage: only ${live.length} live script(s) detected in package.json.
That is far below the known corpus (~90) — LIVE_COMMAND has almost certainly stopped matching.
Refusing to report success on a set this small; fix the matcher.`,
    );
    process.exit(1);
  }

  // The same guard for the file half: an empty walk would make the check below vacuous.
  if (files.length < 80) {
    console.error(
      `FAIL check-live-suite-coverage: only ${files.length} live suite FILE(s) found on disk.
That is far below the known corpus (~120) — the walk or LIVE_FILE has stopped matching.
Refusing to report success on a set this small; fix the matcher.`,
    );
    process.exit(1);
  }

  if (unscripted.length > 0) {
    console.error(
      `FAIL check-live-suite-coverage: ${unscripted.length} live suite FILE(s) are named by NO package.json script.
Nothing runs them — not CI, not a git hook, and not \`bun run test\` (which never sets the live env vars),
so they report green by never running:
${unscripted.map((f) => `  - ${f}`).join("\n")}
Give each a \`test:…:live\` script and add it to a ci.yml matrix row, or — if it is not a suite of its
own — name it in NOT_A_SUITE_FILE in this file, so the exclusion is on the record.`,
    );
    process.exit(1);
  }

  if (staleDeferrals.length > 0) {
    console.error(
      `FAIL check-live-suite-coverage: ${staleDeferrals.length} deferral(s) are STALE — the script is now
run by a ci.yml job, so the DEFERRED entry is obsolete and must be deleted:
${staleDeferrals.map((n) => `  - ${n}`).join("\n")}`,
    );
    process.exit(1);
  }

  if (unwired.length > 0) {
    console.error(
      `FAIL check-live-suite-coverage: ${unwired.length} live suite(s) in package.json are run by NO ci.yml job.
They self-SKIP without their live-service env var, so nothing will ever report them red:
${unwired.map((name) => `  - ${name}`).join("\n")}
Add each to a matrix row in .github/workflows/ci.yml (see the \`lifecycle-live\` / \`rls-live\` jobs),
or — if it genuinely cannot run yet — add it to DEFERRED in this file WITH the blocking reason.`,
    );
    process.exit(1);
  }

  const suffix =
    deferred.length > 0
      ? `; ${deferred.length} explicitly deferred (${deferred.join(", ")}) — see DEFERRED in ${"scripts/check-live-suite-coverage.ts"}`
      : "";
  console.log(
    `OK live-suite-coverage: all ${live.length - deferred.length} live suite(s) are wired into a ci.yml job${suffix}; ` +
      `all ${files.length} suite file(s) are named by a script`,
  );
}

if (import.meta.main) main();
