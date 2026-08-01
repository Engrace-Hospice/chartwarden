/**
 * WardenX — OpenAPI enrichment-coverage report + ratchet gate
 * ----------------------------------------------------------
 * Closes the hole the M20-T06 post-mortem found: `openapi:check` verifies that
 * openapi.json was REGENERATED and that every enrichment points at a real route.
 * It says nothing about the other direction — a route with NO enrichment is
 * perfectly legal, so a routes task can ship 30+ routes carrying zero request
 * contracts with all gates green.
 *
 * That is not merely a missing doc. `emit.ts` still writes those routes into
 * openapi.json with `parameters: []`, no `requestBody`, and a bare `200: OK`,
 * and `client:gen` turns that into a typed client whose POST bodies are `never`
 * -typed. The contract does not look absent — it looks SATISFIED.
 *
 * The status matrix's `Enriched` column could not catch this either: it was a
 * per-module boolean that flipped ✅ on a single enrichment anywhere in the
 * module, so it only ever read ❌ at exactly zero. M06 sat at 6/46 with a ✅.
 *
 * ── What this gate enforces ──────────────────────────────────────────────────
 * A RATCHET, not a cliff. Retro-enriching all 963 routes is a separate project;
 * what must stop today is coverage getting WORSE. Per module we track the
 * `deficit` = routes with no enrichment entry at all, against a committed
 * baseline (audit/openapi-coverage/baseline.json):
 *
 *   deficit > baseline  → VIOLATION. New routes landed unenriched. Add entries
 *                         to scripts/openapi/enrichments.ts.
 *   deficit < baseline  → STALE BASELINE. Progress must be locked in, else the
 *                         ratchet silently re-opens the slack. Run --update.
 *   module absent from baseline → baseline 0, so a brand-new module's very
 *                         first unenriched route fails. This is the M20 case.
 *
 * Usage:
 *   bun run scripts/report-openapi-coverage.ts           (bun run openapi:coverage)
 *   bun run scripts/report-openapi-coverage.ts --check   (bun run arch:openapi-coverage)
 *   bun run scripts/report-openapi-coverage.ts --update  (re-baseline after enriching)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROUTE_ENRICHMENTS } from "./openapi/enrichments";
import { type ScannedRoute, routeKey, scanRoutes } from "./openapi/scan-routes";

const ROOT = process.cwd();
const OUT_DIR = "audit/openapi-coverage";
const OUT_MD = `${OUT_DIR}/OPENAPI_COVERAGE.md`;
const OUT_JSON = `${OUT_DIR}/OPENAPI_COVERAGE.json`;
const BASELINE = `${OUT_DIR}/baseline.json`;

const CHECK = process.argv.includes("--check");
const UPDATE = process.argv.includes("--update");

const MUTATING = new Set(["post", "put", "patch"]);

interface ModuleCoverage {
  module: string;
  routes: number;
  enriched: number;
  /** routes with no enrichment entry at all — the ratcheted number */
  deficit: number;
  mutating: number;
  /** POST/PUT/PATCH with no `body` schema — sends an undocumented payload */
  mutatingNoBody: number;
  gets: number;
  getsNoResponse: number;
}

function collect(routes: ScannedRoute[]): ModuleCoverage[] {
  const by = new Map<string, ModuleCoverage>();
  for (const r of routes) {
    const cov =
      by.get(r.module) ??
      ({
        module: r.module,
        routes: 0,
        enriched: 0,
        deficit: 0,
        mutating: 0,
        mutatingNoBody: 0,
        gets: 0,
        getsNoResponse: 0,
      } satisfies ModuleCoverage);
    const e = ROUTE_ENRICHMENTS[routeKey(r)];
    cov.routes++;
    if (e) cov.enriched++;
    else cov.deficit++;
    if (MUTATING.has(r.method)) {
      cov.mutating++;
      if (!e?.body) cov.mutatingNoBody++;
    }
    if (r.method === "get") {
      cov.gets++;
      if (!e?.response) cov.getsNoResponse++;
    }
    by.set(r.module, cov);
  }
  return [...by.values()].sort((a, b) => a.module.localeCompare(b.module));
}

const routes = scanRoutes(ROOT);
const coverage = collect(routes);

const totals = coverage.reduce(
  (acc, c) => ({
    routes: acc.routes + c.routes,
    enriched: acc.enriched + c.enriched,
    deficit: acc.deficit + c.deficit,
    mutating: acc.mutating + c.mutating,
    mutatingNoBody: acc.mutatingNoBody + c.mutatingNoBody,
    gets: acc.gets + c.gets,
    getsNoResponse: acc.getsNoResponse + c.getsNoResponse,
  }),
  { routes: 0, enriched: 0, deficit: 0, mutating: 0, mutatingNoBody: 0, gets: 0, getsNoResponse: 0 },
);

// ---- baseline ---------------------------------------------------------------
type Baseline = Record<string, { routes: number; deficit: number }>;

function readBaseline(): Baseline {
  if (!existsSync(join(ROOT, BASELINE))) return {};
  return JSON.parse(readFileSync(join(ROOT, BASELINE), "utf8")).modules as Baseline;
}

function renderBaseline(): string {
  const modules: Baseline = {};
  for (const c of coverage) modules[c.module] = { routes: c.routes, deficit: c.deficit };
  return `${JSON.stringify(
    {
      $comment:
        "RATCHET FLOOR for OpenAPI enrichment coverage. `deficit` = routes with no entry in " +
        "scripts/openapi/enrichments.ts. A module's deficit may never RISE (new routes must ship " +
        "their contracts); when it FALLS, re-baseline with `bun run openapi:coverage --update` to " +
        "lock the progress in. A module missing here has an implied floor of 0.",
      modules,
    },
    null,
    2,
  )}\n`;
}

// ---- render -----------------------------------------------------------------
const pct = (n: number, d: number) => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)}%`);

function renderMarkdown(): string {
  const l: string[] = [];
  l.push("# WardenX — OpenAPI Enrichment Coverage");
  l.push("");
  l.push(
    "> **Generated** (`bun run openapi:coverage`). Do not hand-edit — `arch:openapi-coverage`",
  );
  l.push("> (in `arch:fitness`) keeps this in sync with source and enforces the ratchet.");
  l.push("");
  l.push(
    "`openapi:check` proves openapi.json was regenerated and that no enrichment targets a dead " +
      "route. It does NOT prove a route carries a request contract — an unenriched route is still " +
      "emitted, with no `requestBody` and a bare `200: OK`, and the generated client then types its " +
      "body as `never`. This report is the coverage half.",
  );
  l.push("");
  l.push(
    `**Totals:** ${totals.enriched}/${totals.routes} routes enriched (${pct(totals.enriched, totals.routes)}) · ` +
      `**${totals.mutatingNoBody}/${totals.mutating} mutating routes carry no request-body schema** · ` +
      `${totals.getsNoResponse}/${totals.gets} GETs carry no response schema`,
  );
  l.push("");
  l.push(
    "`Deficit` = routes with no enrichment entry; it is the ratcheted number (see " +
      "`baseline.json`). `Mut. no body` is the sharpest signal — a POST that validates a TypeBox " +
      "body in its handler but publishes none is a contract that lies by omission.",
  );
  l.push("");
  l.push("| Module | Routes | Enriched | Deficit | Mutating | Mut. no body | GET | GET no resp |");
  l.push("|---|--:|--:|--:|--:|--:|--:|--:|");
  for (const c of coverage)
    l.push(
      `| ${c.module} | ${c.routes} | ${c.enriched} (${pct(c.enriched, c.routes)}) | ${c.deficit} | ` +
        `${c.mutating} | ${c.mutatingNoBody} | ${c.gets} | ${c.getsNoResponse} |`,
    );
  l.push("");
  return l.join("\n");
}

const md = renderMarkdown();
const jsonOut = `${JSON.stringify({ totals, modules: coverage }, null, 2)}\n`;

// ---- emit / check -----------------------------------------------------------
function write(): void {
  mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
  writeFileSync(join(ROOT, OUT_MD), md);
  writeFileSync(join(ROOT, OUT_JSON), jsonOut);
}

if (UPDATE) {
  write();
  writeFileSync(join(ROOT, BASELINE), renderBaseline());
  console.log(
    `✓ openapi-coverage: re-baselined (${totals.deficit} unenriched of ${totals.routes} routes)`,
  );
  process.exit(0);
}

const baseline = readBaseline();
const violations: string[] = [];
const stale: string[] = [];

for (const c of coverage) {
  const base = baseline[c.module];
  // A module with no baseline row has an implied floor of 0 — a brand-new module
  // must ship its routes enriched. This is exactly the M20-T06 case.
  const floor = base?.deficit ?? 0;
  if (c.deficit > floor) {
    const added = c.routes - (base?.routes ?? 0);
    violations.push(
      `${c.module}: ${c.deficit} unenriched routes exceeds baseline ${floor}` +
        (added > 0 ? ` (+${added} route(s) since baseline, ${c.deficit - floor} unenriched)` : ""),
    );
  } else if (c.deficit < floor) {
    stale.push(`${c.module}: ${c.deficit} unenriched, baseline still claims ${floor}`);
  }
}

if (CHECK) {
  const fresh =
    existsSync(join(ROOT, OUT_MD)) &&
    readFileSync(join(ROOT, OUT_MD), "utf8") === md &&
    existsSync(join(ROOT, OUT_JSON)) &&
    readFileSync(join(ROOT, OUT_JSON), "utf8") === jsonOut;
  if (!fresh) {
    console.error(`✗ openapi-coverage: ${OUT_MD} is out of date. Run: bun run openapi:coverage`);
    process.exit(1);
  }
  if (violations.length) {
    console.error(
      `✗ openapi-coverage: ${violations.length} module(s) LOST enrichment coverage — new routes shipped with no request contract:`,
    );
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "\n  Add the route's TypeBox body/query/response to scripts/openapi/enrichments.ts,\n" +
        "  then: bun run openapi:emit && bun run client:gen && bun run openapi:coverage",
    );
    process.exit(1);
  }
  if (stale.length) {
    console.error(
      `✗ openapi-coverage: coverage IMPROVED in ${stale.length} module(s) but the baseline was not tightened:`,
    );
    for (const s of stale) console.error(`  - ${s}`);
    console.error("\n  Lock the progress in: bun run openapi:coverage --update");
    process.exit(1);
  }
  console.log(
    `OK openapi-coverage: report fresh, ratchet held (${totals.enriched}/${totals.routes} enriched; ${totals.mutatingNoBody} mutating routes still lack a body schema)`,
  );
  process.exit(0);
}

write();
console.log(
  `✓ openapi-coverage → ${OUT_MD} (${totals.enriched}/${totals.routes} enriched; ${totals.mutatingNoBody} mutating routes lack a body schema)`,
);
if (violations.length) {
  console.log(`  ⚠ ${violations.length} module(s) exceed the ratchet baseline:`);
  for (const v of violations) console.log(`    - ${v}`);
}
