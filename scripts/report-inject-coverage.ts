/**
 * ChartWarden — Inject-suite coverage report + ratchet gate (TASK-050A, TEST-001)
 * -----------------------------------------------------------------------------
 * TEST-001: two-thirds of mounted routes have no HTTP-layer test. The "route tests" for
 * M14–M21/M23–M27/M29–M35/M37 assert permission catalogs and ABAC predicates as pure functions —
 * `oncall-routes.test.ts`'s own header says it outright: "these tests are about the DECISIONS, not
 * the SQL." A mis-wired guard/schema/service on a route (the M30 dead-`inOrg` class; the Claim
 * Workbench 404) is invisible to a pure-function test — only a real Fastify `inject()` call through
 * the full middleware chain catches it.
 *
 * ── What this gate enforces ──────────────────────────────────────────────────
 * A RATCHET, not a cliff — same shape as `report-openapi-coverage.ts`'s baseline. Retro-covering
 * ~950 route defs across 22 modules is a separate, multi-session project (TASK-050A); what must
 * stop today is a module shipping with ZERO HTTP-layer test. Per module with a `routes/` dir:
 *
 *   missing AND not in baseline  → VIOLATION. A module lost (or never had) coverage.
 *   covered AND still in baseline → STALE BASELINE. Progress must be locked in, else the ratchet
 *                                   silently re-opens the slack. Run --update.
 *   module absent from baseline  → implied "must be covered". A brand-new module with a `routes/`
 *                                   dir and no inject suite fails immediately.
 *
 * "Covered" is a per-module boolean, not a per-route count (unlike openapi-coverage) — TASK-050A's
 * own acceptance criteria is "zero modules that have a routes/ dir and no inject suite," not full
 * per-route parity. A module counts as covered when some `apps/backend/__tests__/*.test.ts` file
 * both calls `.inject(` AND imports from that module's `src/modules/<slug>/` tree — the same
 * signal a human reviewer would use, cheap enough to not need AST parsing.
 *
 * Usage:
 *   bun run scripts/report-inject-coverage.ts           (bun run inject:coverage)
 *   bun run scripts/report-inject-coverage.ts --check    (bun run arch:inject-coverage)
 *   bun run scripts/report-inject-coverage.ts --update   (re-baseline after adding a suite)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanRoutes } from "./openapi/scan-routes";

const ROOT = process.cwd();
const MODULES_DIR = "apps/backend/src/modules";
const TEST_DIR = "apps/backend/__tests__";
const OUT_DIR = "audit/inject-coverage";
const OUT_MD = `${OUT_DIR}/INJECT_COVERAGE.md`;
const OUT_JSON = `${OUT_DIR}/INJECT_COVERAGE.json`;
const BASELINE = `${OUT_DIR}/baseline.json`;

const CHECK = process.argv.includes("--check");
const UPDATE = process.argv.includes("--update");

interface ModuleCoverage {
  module: string;
  routes: number;
  covered: boolean;
  suiteFiles: string[];
  /**
   * WX-PR-021 (TEST-002) — ADVISORY ONLY, does not affect `covered` or the ratchet below. TEST-002's
   * finding was exactly the risk in `covered` being a per-module boolean: "One inject suite can
   * cause every route in a module to appear covered." This is a real, if approximate, per-ROUTE
   * signal alongside it — how many of the module's route DEFS have their own literal path referenced
   * somewhere in a covering suite, not just "some file in this module has an .inject( call." A
   * static-prefix substring match (no AST), so it both under- and over-counts at the margins (a
   * route hit only via a helper function's own literal, or a route whose path happens to be a
   * substring of an unrelated one, several modules genuinely share slug-adjacent prefixes) — good
   * enough to see "1 route out of 40 referenced" vs. "38 out of 40," not precise enough to ratchet
   * on. True per-route (method+path+status+permission) coverage needs the AST-driven, multi-session
   * rebuild this file's own header already called out; this is the cheap first step toward it.
   */
  directRoutesReferenced: number;
}

function modulesWithRoutesDir(): string[] {
  const dir = join(ROOT, MODULES_DIR);
  return readdirSync(dir)
    .filter((entry) => statSync(join(dir, entry)).isDirectory())
    .filter((entry) => existsSync(join(dir, entry, "routes")))
    .sort();
}

function testFiles(): string[] {
  const dir = join(ROOT, TEST_DIR);
  // `.sort()` is load-bearing, not cosmetic: readdirSync's order is filesystem-dependent (ext4 on
  // Linux CI vs APFS locally), and a module covered by multiple suite files renders that list
  // verbatim into INJECT_COVERAGE.md/.json (renderMarkdown, `suiteFiles.join(", ")`) — an unsorted
  // list is byte-identical in CONTENT but not in ORDER across environments, so --check's exact
  // string comparison spuriously fails on whichever environment didn't generate the committed report.
  return readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => join(TEST_DIR, f))
    .sort();
}

const INJECT_RE = /\.inject\(/;
function moduleImportRe(slug: string): RegExp {
  return new RegExp(`modules/${slug}/`);
}

/** Everything up to (not including) the first `:param` segment, kept up to its trailing slash. */
function staticPrefixOf(path: string): string {
  const idx = path.indexOf("/:");
  return idx === -1 ? path : path.slice(0, idx + 1);
}

/** See `ModuleCoverage.directRoutesReferenced` — an approximate, additive, non-ratcheted signal. */
function isRouteDirectlyReferenced(path: string, suiteSources: readonly string[]): boolean {
  const needle = path.includes("/:") ? staticPrefixOf(path) : path;
  return suiteSources.some((src) => src.includes(needle));
}

function collect(): ModuleCoverage[] {
  const modules = modulesWithRoutesDir();
  const routes = scanRoutes(ROOT);
  const routesByModule = new Map<string, string[]>();
  for (const r of routes)
    routesByModule.set(r.module, [...(routesByModule.get(r.module) ?? []), r.path]);

  const files = testFiles();
  const fileContents = new Map<string, string>();
  for (const f of files) fileContents.set(f, readFileSync(join(ROOT, f), "utf8"));

  return modules.map((slug) => {
    const suiteFiles = files.filter((f) => {
      const src = fileContents.get(f)!;
      return INJECT_RE.test(src) && moduleImportRe(slug).test(src);
    });
    const suiteSources = suiteFiles.map((f) => fileContents.get(f)!);
    const modulePaths = routesByModule.get(slug) ?? [];
    return {
      module: slug,
      routes: modulePaths.length,
      covered: suiteFiles.length > 0,
      suiteFiles,
      directRoutesReferenced: modulePaths.filter((p) => isRouteDirectlyReferenced(p, suiteSources))
        .length,
    };
  });
}

const coverage = collect();
const totals = {
  modules: coverage.length,
  covered: coverage.filter((c) => c.covered).length,
  routes: coverage.reduce((n, c) => n + c.routes, 0),
  coveredRoutes: coverage.filter((c) => c.covered).reduce((n, c) => n + c.routes, 0),
  directRoutesReferenced: coverage.reduce((n, c) => n + c.directRoutesReferenced, 0),
};

// ---- baseline (known-missing modules) ----------------------------------------
type Baseline = { modules: Record<string, { missing: true }> };

function readBaseline(): Set<string> {
  if (!existsSync(join(ROOT, BASELINE))) return new Set();
  const parsed = JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8")) as Baseline;
  return new Set(Object.keys(parsed.modules));
}

function renderBaseline(): string {
  const modules: Baseline["modules"] = {};
  for (const c of coverage) if (!c.covered) modules[c.module] = { missing: true };
  return `${JSON.stringify(
    {
      $comment:
        "RATCHET FLOOR for the inject-suite coverage gate (TASK-050A, TEST-001). Lists modules that " +
        "currently have NO genuine Fastify .inject() HTTP-layer smoke suite (pure-function " +
        "permission/ABAC tests do not count). A module listed here is known debt — it may not gain " +
        "MORE debt (there's only one state, missing) and a module NOT listed here is required to stay " +
        "covered. When a module gains its suite, remove it here (or run --update) to lock the " +
        "progress in; a brand-new module with a routes/ dir and no suite fails immediately (implied " +
        "floor: covered).",
      modules,
    },
    null,
    2,
  )}\n`;
}

// ---- render -------------------------------------------------------------------
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`);

function renderMarkdown(): string {
  const l: string[] = [];
  l.push("# ChartWarden — Inject-Suite (HTTP-layer) Coverage");
  l.push("");
  l.push(
    "> **Generated** (`bun run inject:coverage`). Do not hand-edit — `arch:inject-coverage` (in " +
      "`arch:fitness`) keeps this in sync with source and enforces the ratchet.",
  );
  l.push("");
  l.push(
    "A module's pure-function permission/ABAC tests prove its DECISIONS are correct; they prove " +
      "nothing about the route wiring, schema validation, or service composition around them (the " +
      "M30 dead-`inOrg` class, the Claim Workbench 404). `covered` requires a real Fastify " +
      "`.inject()` call through the module's route registrar.",
  );
  l.push("");
  l.push(
    `**Totals:** ${totals.covered}/${totals.modules} modules covered (${pct(totals.covered, totals.modules)}) · ${totals.coveredRoutes}/${totals.routes} route defs sit behind a covered module · ${totals.directRoutesReferenced}/${totals.routes} route defs are directly referenced by path in a covering suite (TEST-002 — approximate, advisory, not ratcheted; see the directRoutesReferenced field's doc comment in this script for its limits)`,
  );
  l.push("");
  l.push("| Module | Routes | Covered | Direct refs | Suite file(s) |");
  l.push("|---|--:|:--:|--:|---|");
  for (const c of coverage)
    l.push(
      `| ${c.module} | ${c.routes} | ${c.covered ? "✅" : "❌"} | ${c.directRoutesReferenced}/${c.routes} | ${c.suiteFiles.join(", ") || "—"} |`,
    );
  l.push("");
  return l.join("\n");
}

const md = renderMarkdown();
const jsonOut = `${JSON.stringify({ totals, modules: coverage }, null, 2)}\n`;

function write(): void {
  mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
  writeFileSync(join(ROOT, OUT_MD), md);
  writeFileSync(join(ROOT, OUT_JSON), jsonOut);
}

if (UPDATE) {
  write();
  writeFileSync(join(ROOT, BASELINE), renderBaseline());
  console.log(
    `✓ inject-coverage: re-baselined (${totals.covered}/${totals.modules} modules covered)`,
  );
  process.exit(0);
}

const baselineMissing = readBaseline();
const violations: string[] = [];
const stale: string[] = [];

for (const c of coverage) {
  const expectedMissing = baselineMissing.has(c.module);
  if (!c.covered && !expectedMissing) {
    violations.push(`${c.module}: no inject suite found (${c.routes} route defs unexercised)`);
  } else if (c.covered && expectedMissing) {
    stale.push(`${c.module}: now covered, baseline still lists it as missing`);
  }
}

if (CHECK) {
  const fresh =
    existsSync(join(ROOT, OUT_MD)) &&
    readFileSync(join(ROOT, OUT_MD), "utf8") === md &&
    existsSync(join(ROOT, OUT_JSON)) &&
    readFileSync(join(ROOT, OUT_JSON), "utf8") === jsonOut;
  if (!fresh) {
    console.error(`✗ inject-coverage: ${OUT_MD} is out of date. Run: bun run inject:coverage`);
    process.exit(1);
  }
  if (violations.length) {
    console.error(
      `✗ inject-coverage: ${violations.length} module(s) have NO HTTP-layer smoke suite:`,
    );
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "\n  Add a table-driven 401/403/422/2xx apps/backend/__tests__/<module>-routes.test.ts,\n" +
        "  then: bun run inject:coverage --update",
    );
    process.exit(1);
  }
  if (stale.length) {
    console.error(
      `✗ inject-coverage: coverage IMPROVED in ${stale.length} module(s) but the baseline was not tightened:`,
    );
    for (const s of stale) console.error(`  - ${s}`);
    console.error("\n  Lock the progress in: bun run inject:coverage --update");
    process.exit(1);
  }
  console.log(
    `OK inject-coverage: report fresh, ratchet held (${totals.covered}/${totals.modules} modules covered)`,
  );
  process.exit(0);
}

write();
console.log(`✓ inject-coverage → ${OUT_MD} (${totals.covered}/${totals.modules} modules covered)`);
if (violations.length) {
  console.log(`  ⚠ ${violations.length} module(s) exceed the ratchet baseline:`);
  for (const v of violations) console.log(`    - ${v}`);
}
