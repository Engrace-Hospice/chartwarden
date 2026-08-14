/**
 * WardenX — live-suite CI coverage gate (GAP-086)
 * ---------------------------------------------------------------------
 * Every `test:m<N>:…:live` script in package.json must be RUN by a job in `.github/workflows/ci.yml`.
 *
 * This gate exists because the failure it catches is silent in both directions. A live suite is
 * `describe.skipIf(!WARDENX_TEST_DATABASE_URL)`, so with no database it reports as SKIPPED, not failed —
 * `bun run test` stays green whether the suite passes, would fail, or has rotted beyond running. And a
 * script in package.json looks wired to a reader; nothing distinguishes one a CI job invokes from one
 * nothing has ever run. That combination let 25 lifecycle suites — 205 assertions across the entire
 * clinical-core write path — sit unexecuted outside their authors' laptops until an audit went looking.
 * 23 of the 25 were red by the time anyone did.
 *
 * The check is deliberately textual: it asserts the script NAME appears somewhere in ci.yml, without
 * caring which job or how the matrix is shaped. That tolerates re-grouping the matrix rows freely while
 * still failing the moment a new live suite ships with no runner.
 *
 * Usage: `bun run arch:live-suites` (wired into `arch:fitness`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CI_PATH = join(ROOT, ".github", "workflows", "ci.yml");

/** Matches the per-module live-suite scripts: `test:m6:write:live`, `test:rls:live:m30`, … */
const LIVE_SCRIPT = /^test:(m\d+:[a-z0-9]+:live|rls:live(:m\d+)?)$/;

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const ci = readFileSync(CI_PATH, "utf8");

const live = Object.keys(pkg.scripts).filter((name) => LIVE_SCRIPT.test(name)).sort();
// A shorter script name can be a prefix of a longer one (`test:rls:live` vs `test:rls:live:m6`), so match
// on a word boundary — otherwise the baseline suite would look covered by any of its per-module siblings.
const unwired = live.filter((name) => !new RegExp(`${name}(?![\\w:-])`).test(ci));

if (unwired.length > 0) {
  console.error(
    `FAIL check-live-suite-coverage: ${unwired.length} live-DB script(s) in package.json are run by NO ci.yml job.\n` +
      "They self-SKIP without WARDENX_TEST_DATABASE_URL, so nothing will ever report them red:\n" +
      unwired.map((name) => `  - ${name}`).join("\n") +
      "\nAdd each to a matrix row in .github/workflows/ci.yml (see the `lifecycle-live` / `rls-live` jobs).",
  );
  process.exit(1);
}

console.log(`OK live-suite-coverage: all ${live.length} live-DB script(s) are wired into a ci.yml job`);
