/**
 * WardenX — UI Implementation-Parity Report (audit remediation #5)
 * ----------------------------------------------------------------
 * `docs:ui` proves the UI screen-spec CORPUS is internally consistent; it says nothing about
 * how much of that documented surface is actually BUILT in apps/web. This report bridges the
 * documented surface (docs/ui screen specs) and the implemented surface (registered web
 * `screens.ts`), so a green `docs:ui` is never mistaken for "the UI is built".
 *
 * It is ADVISORY on coverage: a documented-but-unbuilt screen is roadmap, not a defect. Note the
 * doc specs are feature-named files with no shared key to a registered screen, and screen `path`s
 * are frontend routes (not API paths) — so coverage is reported as a gap SUMMARY, not a fake
 * per-screen join.
 *
 * What IS precise — and hard-fails, because these are real wiring defects the doc-corpus check
 * does not catch (the analog of the implementation-matrix orphan-table checks):
 *   - DUP SCREEN ID    — two registered screens share an `id`.
 *   - DUP SCREEN PATH  — two registered screens share a route `path`.
 *   - UNKNOWN PERMISSION — a screen's `requiredPermission` is not in the permission catalog
 *                          (nav-gating points at a permission that does not exist).
 *   - UNREGISTERED SCREENS — a module `screens.ts` exists but is not wired into main.tsx
 *                          (the screens silently never load).
 *
 * Modes:
 *   bun run scripts/report-ui-parity.ts            → regenerate the report
 *   bun run scripts/report-ui-parity.ts --check    → fail if the committed report is stale,
 *                                                    plus run the hard-fails
 *
 * Writes audit/ui-parity/UI_PARITY.md (+ .json).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CHECK = process.argv.includes("--check");
const OUT_DIR = "audit/ui-parity";
const OUT_MD = join(OUT_DIR, "UI_PARITY.md");
const OUT_JSON = join(OUT_DIR, "ui-parity.json");

const read = (rel: string) => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

// ---- documented surface: UI screen-spec files listed in the index --------------------------
const indexSrc = read("docs/ui/WARDENX_UI_COMPLETE_SCREEN_INDEX.md");
const docSpecs = [...indexSrc.matchAll(/`(screens\/[^`]+\.md)`/g)].map((m) => m[1]!);
const docByCategory = new Map<string, number>();
for (const f of docSpecs) {
  const cat = f.split("/")[1] ?? "(uncategorized)";
  docByCategory.set(cat, (docByCategory.get(cat) ?? 0) + 1);
}

// ---- permission catalog: every valid permission key ----------------------------------------
const catalog = new Set<string>();
for (const f of [
  "packages/auth/src/permissions/catalog.ts",
  "packages/auth/src/permissions/contributed.ts",
])
  // Keys are 2- or 3-segment (`assessment.read`, `hope.schedule.read`); capture an optional third segment
  // so 3-segment contributed keys (M10 HOPE, M38 terminology, …) resolve as valid requiredPermissions.
  for (const m of read(f).matchAll(/"([a-z_]+\.[a-z_]+(?:\.[a-z_]+)?)"/g)) catalog.add(m[1]!);

// ---- implemented surface: registered web screens -------------------------------------------
const mainTsx = read("apps/web/src/main.tsx");
const moduleDirs = (() => {
  try {
    return readdirSync(join(ROOT, "apps/web/src/modules")).filter((d) =>
      existsSync(join(ROOT, "apps/web/src/modules", d, "screens.ts")),
    );
  } catch {
    return [];
  }
})();

type Screen = {
  module: string;
  moduleId: number | null;
  id: string;
  path: string;
  permission: string;
};
const screens: Screen[] = [];
const unregistered: string[] = [];

for (const dir of moduleDirs.sort()) {
  const rel = `apps/web/src/modules/${dir}/screens.ts`;
  const src = read(rel);
  const moduleId = src.match(/moduleId:\s*(\d+)/)?.[1];
  // a module is "wired" if main.tsx imports its dir
  if (!mainTsx.includes(`modules/${dir}`)) unregistered.push(rel);
  // each screen entry: anchor on `id:`; fields belong to the screen until the next `id:`
  const ids = [...src.matchAll(/\bid:\s*["']([^"']+)["']/g)];
  for (let i = 0; i < ids.length; i++) {
    const start = ids[i]!.index!;
    const end = i + 1 < ids.length ? ids[i + 1]!.index! : src.length;
    const block = src.slice(start, end);
    screens.push({
      module: dir,
      moduleId: moduleId ? Number(moduleId) : null,
      id: ids[i]![1]!,
      path: block.match(/\bpath:\s*["']([^"']+)["']/)?.[1] ?? "(none)",
      permission: block.match(/requiredPermission:\s*["']([^"']+)["']/)?.[1] ?? "(none)",
    });
  }
}

// ---- hard-fail consistency checks ----------------------------------------------------------
const failures: string[] = [];
const seenId = new Map<string, string>();
const seenPath = new Map<string, string>();
for (const s of screens) {
  if (seenId.has(s.id))
    failures.push(`DUP SCREEN ID: "${s.id}" in ${s.module} and ${seenId.get(s.id)}`);
  else seenId.set(s.id, s.module);
  if (s.path !== "(none)") {
    if (seenPath.has(s.path))
      failures.push(`DUP SCREEN PATH: "${s.path}" in ${s.module} and ${seenPath.get(s.path)}`);
    else seenPath.set(s.path, s.module);
  }
  if (s.permission !== "(none)" && !catalog.has(s.permission))
    failures.push(
      `UNKNOWN PERMISSION: screen "${s.id}" (${s.module}) requires "${s.permission}", not in the permission catalog`,
    );
}
for (const u of unregistered)
  failures.push(`UNREGISTERED SCREENS: ${u} exists but is not wired into apps/web/src/main.tsx`);

// ---- render --------------------------------------------------------------------------------
const implementedModules = [...new Set(screens.map((s) => s.module))].sort();
function renderMarkdown(): string {
  const L: string[] = [];
  L.push("# WardenX — UI Implementation-Parity Report");
  L.push("");
  L.push(
    "> **Generated, advisory report** (`bun run ui:parity`). `docs:ui` proves the screen-spec",
  );
  L.push(
    "> corpus is consistent; this shows how much of it is BUILT in `apps/web`. Do not hand-edit —",
  );
  L.push("> the `ui:parity --check` gate (in `arch:fitness`) keeps it in sync with source.");
  L.push("");
  L.push(
    `**Coverage:** ${docSpecs.length} documented screen specs · ${implementedModules.length} module screen-sets registered · ${screens.length} screens wired in \`apps/web\`.`,
  );
  L.push("");
  L.push(
    "> The documented vs implemented counts are a deliberate gap *summary*, not a per-screen join: UI specs are feature-named docs with no shared key to a registered screen, and screen `path`s are frontend routes (not API paths). The per-screen table below is the precise, checkable surface.",
  );
  L.push("");
  L.push("## Documented surface (by category)");
  L.push("");
  for (const [cat, n] of [...docByCategory].sort()) L.push(`- **${cat}**: ${n} spec(s)`);
  L.push("");
  L.push("## Implemented surface (registered screens)");
  L.push("");
  L.push("| Module | Screen id | Route path | Required permission | Permission resolves |");
  L.push("|---|---|---|---|:--:|");
  for (const s of screens)
    L.push(
      `| ${s.module} | \`${s.id}\` | \`${s.path}\` | \`${s.permission}\` | ${s.permission === "(none)" || catalog.has(s.permission) ? "✅" : "❌"} |`,
    );
  L.push("");
  L.push("## Hard-fail consistency checks");
  L.push("");
  L.push(
    failures.length
      ? failures.map((f) => `- ❌ ${f}`).join("\n")
      : "- ✅ No duplicate screen ids/paths, all `requiredPermission`s resolve, all module screen-sets are registered.",
  );
  L.push("");
  return L.join("\n");
}

const md = renderMarkdown();
const jsonOut = JSON.stringify(
  {
    documentedSpecs: docSpecs.length,
    byCategory: Object.fromEntries(docByCategory),
    registeredModules: implementedModules,
    screens,
    failures,
  },
  null,
  2,
);

// ---- emit / check --------------------------------------------------------------------------
if (failures.length) {
  console.error(`✗ ui-parity: ${failures.length} violation(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

if (CHECK) {
  if (read(OUT_MD) !== md || read(OUT_JSON) !== jsonOut) {
    console.error(`✗ ui-parity: ${OUT_MD} is out of date. Run: bun run ui:parity`);
    process.exit(1);
  }
  console.log(
    `OK ui-parity: report fresh (${docSpecs.length} documented · ${screens.length} screens registered)`,
  );
  process.exit(0);
}

mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
writeFileSync(join(ROOT, OUT_MD), md);
writeFileSync(join(ROOT, OUT_JSON), jsonOut);
console.log(
  `✓ ui-parity → ${OUT_MD} (${docSpecs.length} documented · ${screens.length} screens registered)`,
);
