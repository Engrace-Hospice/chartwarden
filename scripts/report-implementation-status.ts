/**
 * WardenX — Module Implementation-Status Matrix (audit remediation #4)
 * --------------------------------------------------------------------
 * A green `arch:fitness` proves the architecture is *coherent* (ownership, boundaries,
 * tenancy, DDL legality) — NOT that a module is *built*. Many manifest-owned modules are
 * deliberate Phase-0 placeholders (the Wave E–P3 roadmap). This report makes build progress
 * visible per module so green gates are never mistaken for feature-completeness.
 *
 * It is ADVISORY: the matrix never fails on incompleteness (a placeholder is not a defect).
 * Two things DO hard-fail, because they are genuine consistency defects regardless of wave
 * progress and are not caught elsewhere (check-table-ownership skips unowned tables):
 *   - ORPHAN SCHEMA    — a `pgTable("x")` defined for a table no module owns.
 *   - ORPHAN MIGRATION — a `CREATE TABLE x` for a table no module owns.
 * One thing WARNS (real schema↔migration drift, but a legitimate mid-wave transient):
 *   - SCHEMA-WITHOUT-MIGRATION — an owned table has a Drizzle def but no CREATE TABLE.
 *
 * Heuristic columns (openapi-enriched, live-infra, adapter) are best-effort and labelled so.
 *
 * Modes:
 *   bun run scripts/report-implementation-status.ts            → regenerate the report
 *   bun run scripts/report-implementation-status.ts --check    → fail if the committed report
 *                                                                is stale, plus run the hard-fails
 *
 * Writes audit/implementation-status/IMPLEMENTATION_STATUS.md (+ .json).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODULES } from "../architecture/module-manifest";
import { ROUTE_ENRICHMENTS } from "./openapi/enrichments";
import { routeKey, scanRoutes } from "./openapi/scan-routes";

const ROOT = process.cwd();
const CHECK = process.argv.includes("--check");
const OUT_DIR = "audit/implementation-status";
const OUT_MD = join(OUT_DIR, "IMPLEMENTATION_STATUS.md");
const OUT_JSON = join(OUT_DIR, "implementation-status.json");

type Mod = { id: number; name: string; codePaths?: string[]; ownedTables?: string[] };
const mods = (MODULES as unknown as Mod[]).slice().sort((a, b) => a.id - b.id);
const pad = (id: number) => String(id).padStart(2, "0");
const M = (id: number) => `M${pad(id)}`;

// ---- recursive file walk (skips heavy/irrelevant dirs) ----------------------
const SKIP = new Set(["node_modules", "dist", ".git", ".turbo"]);
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(ROOT, dir));
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e)) continue;
    const rel = join(dir, e);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(join(ROOT, rel));
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}
const read = (rel: string) => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

// ---- corpus scans (robust, multi-line aware) --------------------------------
const owned = new Map<string, number>(); // table -> owner module id
for (const m of mods) for (const t of m.ownedTables ?? []) owned.set(t, m.id);

// pgTable defs across the Drizzle schema corpus: table -> file
const pgTableRe = /export\s+const\s+\w+\s*=\s*pgTable\(\s*['"]([\w]+)['"]/g;
const schemaTables = new Map<string, string>();
for (const f of walk("packages/db/src/schema")) {
  if (!f.endsWith(".ts")) continue;
  const src = read(f);
  for (let m = pgTableRe.exec(src); m; m = pgTableRe.exec(src)) schemaTables.set(m[1]!, f);
}

// CREATE TABLE in migration SQL: set of migrated table names. Skip partition children
// (`... PARTITION OF <owned-parent>`) and reserved-word captures from the optional IF-NOT-EXISTS.
const createTableRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?([^;]*)/gi;
const RESERVED = new Set(["if", "not", "exists"]);
const migratedTables = new Set<string>();
// `ALTER TABLE x RENAME TO y` (e.g. 1069 hipps_calculation -> per_diem_rate_calculation): the table is migrated under
// its FINAL name, so an old CREATE TABLE must not read as an orphan. Applied after every CREATE has been collected.
const renameTableRe = /alter\s+table\s+(?:if\s+exists\s+)?"?(\w+)"?\s+rename\s+to\s+"?(\w+)"?/gi;
const renamedTables: [string, string][] = [];
for (const f of walk("packages/db/migrations")) {
  if (!f.endsWith(".sql")) continue;
  const src = read(f);
  for (let m = createTableRe.exec(src); m; m = createTableRe.exec(src)) {
    const name = m[1]!;
    if (RESERVED.has(name.toLowerCase())) continue;
    if (/partition\s+of/i.test(m[2]!)) continue; // partition child belongs to its owned parent
    migratedTables.add(name);
  }
  for (let m = renameTableRe.exec(src); m; m = renameTableRe.exec(src))
    renamedTables.push([m[1]!, m[2]!]);
}
for (const [from, to] of renamedTables) {
  if (!migratedTables.delete(from)) continue;
  migratedTables.add(to);
}

// spec files: 7 -> docs/modules/WARDENX_MODULE_07_*.md
const specFiles = (() => {
  try {
    return readdirSync(join(ROOT, "docs/modules")).filter((f) => /^WARDENX_MODULE_\d\d_/.test(f));
  } catch {
    return [];
  }
})();
const hasSpec = (id: number) => specFiles.some((f) => f.startsWith(`WARDENX_MODULE_${pad(id)}_`));

// OpenAPI enrichment: real per-route coverage, joined route-by-route against the
// enrichment registry. This was previously a per-module BOOLEAN derived by regexing
// enrichments.ts for a `modules/NN-*/routes` import — which flipped ✅ on a single
// entry anywhere in the module, so it only ever read ❌ at exactly zero. M06 sat at
// 6 enriched of 46 routes showing ✅. A ratio cannot hide that; the ratchet gate
// (scripts/report-openapi-coverage.ts) is what actually fails the build.
const enrichmentByModule = new Map<number, { routes: number; enriched: number }>();
for (const r of scanRoutes(ROOT)) {
  const id = Number(r.module.match(/^(\d\d)-/)?.[1]);
  if (!Number.isFinite(id)) continue; // "bootstrap" host routes belong to no feature module
  const cur = enrichmentByModule.get(id) ?? { routes: 0, enriched: 0 };
  cur.routes++;
  if (ROUTE_ENRICHMENTS[routeKey(r)]) cur.enriched++;
  enrichmentByModule.set(id, cur);
}

// Web screens: modules whose screens.ts declares a moduleId AND is wired into main.tsx
const mainTsx = read("apps/web/src/main.tsx");
const portalScreenRegistry = read("apps/portal/src/screens/registry.ts");

// Test corpus: backend __tests__ filenames (slug-prefix match) + live test bodies.
// (Module package __tests__ are matched definitively by directory containment, below.)
const backendTestFiles = walk("apps/backend/__tests__")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => f.split("/").pop()!);
const liveTestBodies = walk("apps/backend/__tests__")
  .concat(walk("packages/db/migrations/__tests__"))
  .filter((f) => f.endsWith(".live.test.ts"))
  .map(read)
  .join("\n");

// ---- per-codePath helpers ---------------------------------------------------
const isPlaceholderFile = (rel: string) => /Phase 0 placeholder/i.test(read(rel));
function backendDir(m: Mod) {
  return (m.codePaths ?? []).find((p) => p.startsWith("apps/backend/src/modules/"));
}
function webDir(m: Mod) {
  return (m.codePaths ?? []).find((p) => p.startsWith("apps/web/src/modules/"));
}
function pkgDirs(m: Mod) {
  return (m.codePaths ?? []).filter((p) => p.startsWith("packages/"));
}
const slug = (dir: string) =>
  dir
    .split("/")
    .pop()!
    .replace(/^\d\d-/, "");

// ---- compute one row per module ---------------------------------------------
type Row = {
  id: number;
  module: string;
  status: "Implemented" | "Partial" | "Placeholder";
  spec: boolean;
  schema: boolean;
  migration: boolean;
  routes: boolean;
  /** real per-route OpenAPI enrichment coverage; null = module registers no routes */
  enriched: { routes: number; enriched: number } | null;
  screens: boolean;
  tests: boolean;
  adapter: boolean | null; // null = N/A (module owns no adapter package)
  /**
   * Live-RLS proof coverage: owned tables NAMED in a `*.live.test.ts` / owned tables. null = the
   * module owns no tables. This was a BOOLEAN `tables.some(...)`, which flipped ✅ on a single table
   * name appearing anywhere in any live-suite body — so M35 (a ⚪ placeholder with zero migrations)
   * read `Live ✅` because the words `plan`, `subscription` and `payment_method` occur in unrelated
   * suites, and M5 read ✅ at 1-of-16 while M23's 16 PHI claim tables read ✅ at 0. Same shape as the
   * `Enriched` boolean hole that preceded it: a ratio is the honest signal.
   */
  liveInfra: { tables: number; covered: number } | null;
};

const VENDOR_HINT = /-client$|-adapters$|-vendors$|dosespot|x12-|nppes|telehealth/;

const rows: Row[] = mods.map((m) => {
  const tables = m.ownedTables ?? [];
  const schema = tables.some((t) => schemaTables.has(t));
  const migration = tables.length > 0 && tables.every((t) => migratedTables.has(t));

  const beDir = backendDir(m);
  const beIndex = beDir ? `${beDir}/index.ts` : undefined;
  const bePlaceholder = beIndex
    ? !existsSync(join(ROOT, beIndex)) || isPlaceholderFile(beIndex)
    : true;
  const routes = !!beDir && !bePlaceholder && existsSync(join(ROOT, `${beDir}/routes`));

  // A platform/foundation module (e.g. M01) owns no feature backend dir
  // (`apps/backend/src/modules/*`); its backend surface is bootstrap + packages, so a feature
  // `routes/` dir is not an applicable artifact. Recognise its real (non-placeholder) platform
  // code so it isn't pinned to "Partial" forever for lacking routes it was never meant to expose.
  const foundationBackend =
    !beDir &&
    (m.codePaths ?? []).some((p) => {
      if (!p.startsWith("apps/backend/src/") && !p.startsWith("packages/")) return false;
      if (!existsSync(join(ROOT, p))) return false;
      const idx = `${p}/index.ts`;
      const srcIdx = `${p}/src/index.ts`;
      if (existsSync(join(ROOT, idx))) return !isPlaceholderFile(idx);
      if (existsSync(join(ROOT, srcIdx))) return !isPlaceholderFile(srcIdx);
      return true; // real source dir with no single entry-file convention
    });

  // "Backend built" generalises the headline driver across module kinds: a feature module needs
  // a real, non-placeholder `routes/`; a foundation module needs real platform code.
  const backendBuilt = foundationBackend || (!bePlaceholder && routes);

  const wDir = webDir(m);
  const screensRel = wDir ? `${wDir}/screens.ts` : undefined;
  const webScreens =
    !!screensRel &&
    existsSync(join(ROOT, screensRel)) &&
    /moduleId\s*:/.test(read(screensRel)) &&
    new RegExp(`${slug(wDir!)}|${m.id}\\b`).test(mainTsx);
  // A module whose UI ships in the PORTAL app (M31) has no `apps/web/src/modules/<slug>/screens.ts`; its screens are
  // registered in `apps/portal/src/screens/registry.ts` under its own `moduleId`.
  const portalScreens =
    (m.codePaths ?? []).includes("apps/portal") &&
    new RegExp(`moduleId\\s*:\\s*${m.id}\\b`).test(portalScreenRegistry);
  const screens = webScreens || portalScreens;

  // Tests (heuristic): a definitive hit if any test lives inside the module's own package
  // __tests__ dir, else a backend test filename begins with a module slug (plural OR singular).
  const pkgTests = pkgDirs(m).some((p) =>
    walk(join(p, "__tests__")).some((f) => f.endsWith(".test.ts")),
  );
  const toks = [beDir, wDir]
    .filter(Boolean)
    .map((d) => slug(d as string))
    .flatMap((s) => [s, s.replace(/s$/, "")]);
  const tests =
    pkgTests ||
    backendTestFiles.some((b) => toks.some((t) => b.startsWith(`${t}-`) || b.startsWith(`${t}.`)));

  const adapterPkgs = pkgDirs(m).filter((p) => VENDOR_HINT.test(p));
  const adapter =
    adapterPkgs.length === 0
      ? null
      : adapterPkgs.some(
          (p) =>
            existsSync(join(ROOT, `${p}/src/index.ts`)) && !isPlaceholderFile(`${p}/src/index.ts`),
        );

  // Still a name match against the live-suite bodies — this report cannot execute Postgres — but now
  // counted per table instead of collapsed with `.some()`, so partial coverage is visible as partial.
  const liveCovered = tables.filter((t) => new RegExp(`\\b${t}\\b`).test(liveTestBodies)).length;
  const liveInfra = tables.length === 0 ? null : { tables: tables.length, covered: liveCovered };

  // Headline status keys off the authoritative placeholder marker + the core backend artifacts
  // (schema + a built backend surface — feature `routes/`, or real platform code for a foundation
  // module). Tests/enriched/screens/live are informational columns, not status drivers, because
  // their detection is heuristic and would otherwise misclassify built modules.
  const anySignal = schema || routes || screens || tests;
  let status: Row["status"];
  if (backendBuilt && schema) status = "Implemented";
  else if (bePlaceholder && !anySignal) status = "Placeholder";
  else status = "Partial";

  return {
    id: m.id,
    module: `${M(m.id)} ${m.name}`,
    status,
    spec: hasSpec(m.id),
    schema,
    migration,
    routes,
    enriched: enrichmentByModule.get(m.id) ?? null,
    screens,
    tests,
    adapter,
    liveInfra,
  };
});

// ---- consistency assertions -------------------------------------------------
const failures: string[] = [];
const warnings: string[] = [];

for (const [t, file] of schemaTables)
  if (!owned.has(t))
    failures.push(`ORPHAN SCHEMA: pgTable("${t}") in ${file} is owned by no module`);
for (const t of migratedTables)
  if (!owned.has(t)) failures.push(`ORPHAN MIGRATION: CREATE TABLE "${t}" is owned by no module`);
for (const [t, file] of schemaTables)
  if (owned.has(t) && !migratedTables.has(t))
    warnings.push(
      `SCHEMA-WITHOUT-MIGRATION: owned table "${t}" (${file}) has no CREATE TABLE in migrations`,
    );

// ---- render -----------------------------------------------------------------
const counts = {
  Implemented: rows.filter((r) => r.status === "Implemented").length,
  Partial: rows.filter((r) => r.status === "Partial").length,
  Placeholder: rows.filter((r) => r.status === "Placeholder").length,
};
const yn = (b: boolean | null) => (b === null ? "—" : b ? "✅" : "❌");
/**
 * Enrichment is a RATIO, never a tick. A ✅ here used to mean "≥1 route enriched",
 * which read identically at 46/46 and 6/46 — the failure the M20-T06 post-mortem hit.
 * ⚠️ marks any module still carrying unenriched routes; the ratchet gate
 * (`arch:openapi-coverage`) is what makes a REGRESSION fail the build.
 */
const enr = (e: Row["enriched"]) =>
  e === null ? "—" : `${e.enriched}/${e.routes}${e.enriched < e.routes ? " ⚠️" : " ✅"}`;
/** Live-RLS table coverage as a ratio — see `Row["liveInfra"]` for why this is not a tick. */
const live = (l: Row["liveInfra"]) =>
  l === null ? "—" : `${l.covered}/${l.tables}${l.covered < l.tables ? " ⚠️" : " ✅"}`;
const badge = (s: Row["status"]) =>
  s === "Implemented" ? "🟢 Implemented" : s === "Partial" ? "🟡 Partial" : "⚪ Placeholder";

function renderMarkdown(): string {
  const lines: string[] = [];
  lines.push("# WardenX — Module Implementation-Status Matrix");
  lines.push("");
  lines.push(
    "> **Generated, advisory report** (`bun run status:matrix`). A green `arch:fitness` proves the",
  );
  lines.push(
    "> architecture is coherent, NOT that a module is built. This matrix shows per-module build progress.",
  );
  lines.push(
    "> Do not hand-edit — the `status:matrix --check` gate (in `arch:fitness`) keeps it in sync with source.",
  );
  lines.push("");
  lines.push(
    `**Totals:** 🟢 ${counts.Implemented} Implemented · 🟡 ${counts.Partial} Partial · ⚪ ${counts.Placeholder} Placeholder (of ${rows.length} modules)`,
  );
  lines.push("");
  lines.push(
    "Columns: Spec · Schema (Drizzle defs for owned tables) · Migration (all owned tables in a `CREATE TABLE`) · " +
      "Routes (non-placeholder backend `routes/`) · Enriched (routes carrying an OpenAPI contract / routes scanned — " +
      "a RATIO, not a tick; ⚠️ = some route publishes no request/response schema. `arch:openapi-coverage` ratchets it) · " +
      "Screens (registered web `screens.ts`) · " +
      "Tests (package `__tests__` or slug-matched backend test, *heuristic*) · Adapter (vendor/client package built; — = none owned, *heuristic*) · " +
      "Live (owned tables NAMED in a `*.live.test.ts` / owned tables — a RATIO, and still a name match, " +
      "not an executed proof; ⚠️ marks any module with an unproven table). This column was a boolean " +
      "`some()` and read ✅ for M35, a placeholder with zero migrations. Headline status keys off the " +
      "placeholder marker + schema + routes only.",
  );
  lines.push("");
  lines.push(
    "| Module | Status | Spec | Schema | Migration | Routes | Enriched | Screens | Tests | Adapter | Live |",
  );
  lines.push("|---|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|");
  for (const r of rows)
    lines.push(
      `| ${r.module} | ${badge(r.status)} | ${yn(r.spec)} | ${yn(r.schema)} | ${yn(r.migration)} | ${yn(r.routes)} | ${enr(r.enriched)} | ${yn(r.screens)} | ${yn(r.tests)} | ${yn(r.adapter)} | ${live(r.liveInfra)} |`,
    );
  lines.push("");
  if (warnings.length) {
    lines.push("## ⚠️ Warnings (non-failing)");
    lines.push("");
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("## Hard-fail consistency checks");
  lines.push("");
  lines.push(
    failures.length
      ? failures.map((f) => `- ❌ ${f}`).join("\n")
      : "- ✅ No orphan schema/migration tables (every defined table is owned by a module).",
  );
  lines.push("");
  return lines.join("\n");
}

const md = renderMarkdown();
const jsonOut = JSON.stringify({ totals: counts, rows, warnings, failures }, null, 2);

// ---- emit / check -----------------------------------------------------------
function fail(msg: string): never {
  console.error(`✗ status-matrix: ${msg}`);
  process.exit(1);
}

if (failures.length) {
  // Hard-fails are enforced in BOTH modes — an orphan table is a real defect.
  console.error(`✗ status-matrix: ${failures.length} orphan-table violation(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

if (CHECK) {
  const curMd = read(OUT_MD);
  const curJson = read(OUT_JSON);
  if (curMd !== md || curJson !== jsonOut)
    fail(`${OUT_MD} is out of date. Run: bun run status:matrix`);
  console.log(
    `OK status-matrix: report fresh (🟢 ${counts.Implemented} · 🟡 ${counts.Partial} · ⚪ ${counts.Placeholder}; ${warnings.length} warning(s))`,
  );
  process.exit(0);
}

mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
writeFileSync(join(ROOT, OUT_MD), md);
writeFileSync(join(ROOT, OUT_JSON), jsonOut);
console.log(
  `✓ status-matrix → ${OUT_MD} (🟢 ${counts.Implemented} Implemented · 🟡 ${counts.Partial} Partial · ⚪ ${counts.Placeholder} Placeholder; ${warnings.length} warning(s))`,
);
