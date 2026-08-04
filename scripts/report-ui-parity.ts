/**
 * WardenX — UI Implementation-Parity Report (audit remediation #5; UI-011 widened it to all 3 apps)
 * ---------------------------------------------------------------------------------------------
 * `docs:ui` proves the UI screen-spec CORPUS is internally consistent; it says nothing about
 * how much of that documented surface is actually BUILT. This report bridges the documented
 * surface (docs/design screen specs) and the implemented surface (registered screens across
 * apps/web, apps/portal, and apps/admin), so a green `docs:ui` is never mistaken for "the UI is
 * built".
 *
 * UI-011: this originally scanned `apps/web` only, so the 27 built portal (M31) + admin (M35)
 * screens were invisible to every dup-id/dup-path/permission/wiring check — the M35 admin
 * console read as undocumented rather than "built but unchecked". Now scans all three apps,
 * each via its own registration shape (see APPS below): web/admin register per-module
 * `screens.ts` files into `main.tsx`; portal registers one flat manifest into `app.tsx`.
 * Duplicate-id/path checks are scoped PER APP — three separate SPAs, so e.g. `/account`
 * legitimately existing in both portal and admin is not a collision.
 *
 * It is ADVISORY on doc coverage: a documented-but-unbuilt screen is roadmap, not a defect. Note
 * the doc specs are feature-named files with no shared key to a registered screen, and screen
 * `path`s are frontend routes (not API paths) — so doc coverage is reported as a gap SUMMARY, not
 * a fake per-screen join.
 *
 * What IS precise — and hard-fails, because these are real wiring defects the doc-corpus check
 * does not catch (the analog of the implementation-matrix orphan-table checks):
 *   - DUP SCREEN ID    — two registered screens in the SAME app share an `id`.
 *   - DUP SCREEN PATH  — two registered screens in the SAME app share a route `path`.
 *   - UNKNOWN PERMISSION — a screen's `requiredPermission` is not in the permission catalog
 *                          (nav-gating points at a permission that does not exist).
 *   - UNREGISTERED SCREENS — a web/admin module `screens.ts` exists but is not wired into its
 *                          app's composition root (the screens silently never load). Portal has
 *                          no analogous failure mode: `screens/registry.ts` binds every manifest
 *                          id to a component at import time and throws if one is missing, so an
 *                          unregistered portal screen cannot exist without the app failing to
 *                          build/boot — checked here as UNBOUND PORTAL SCREEN instead.
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
const indexSrc = read("docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md");
const docSpecs = [...indexSrc.matchAll(/`(screens\/[^`]+\.md)`/g)].map((m) => m[1]!);
const docByCategory = new Map<string, number>();
for (const f of docSpecs) {
  const cat = f.split("/")[1] ?? "(uncategorized)";
  docByCategory.set(cat, (docByCategory.get(cat) ?? 0) + 1);
}

// ---- permission catalog: every valid permission key (shared across all 3 apps) -------------
const catalog = new Set<string>();
// Keys are 2- or 3-segment (`assessment.read`, `hope.schedule.read`); capture an optional third segment
// so 3-segment contributed keys (M10 HOPE, M38 terminology, …) resolve as valid requiredPermissions. The
// first segment may carry a module-number prefix (`m37.unit.read`), so digits are allowed in each segment.
for (const f of [
  "packages/auth/src/permissions/catalog.ts",
  "packages/auth/src/permissions/contributed.ts",
])
  for (const m of read(f).matchAll(/"([a-z0-9_]+\.[a-z0-9_]+(?:\.[a-z0-9_]+)?)"/g))
    catalog.add(m[1]!);

type Screen = {
  app: string;
  module: string;
  moduleId: number | null;
  id: string;
  path: string;
  permission: string;
};

/** Parse `{ id: "...", path: "...", requiredPermission: "..." }`-shaped blocks out of a screens
 *  source file's raw text — the same block-per-`id:` anchor approach for every app, since web,
 *  admin, and portal's manifest all declare screens as inline object literals with these keys. */
function parseScreenBlocks(src: string): Array<{ id: string; path: string; permission: string }> {
  const ids = [...src.matchAll(/\bid:\s*["']([^"']+)["']/g)];
  return ids.map((m, i) => {
    const start = m.index!;
    const end = i + 1 < ids.length ? ids[i + 1]!.index! : src.length;
    const block = src.slice(start, end);
    return {
      id: m[1]!,
      path: block.match(/\bpath:\s*["']([^"']+)["']/)?.[1] ?? "(none)",
      permission: block.match(/requiredPermission:\s*["']([^"']+)["']/)?.[1] ?? "(none)",
    };
  });
}

const screens: Screen[] = [];
const failures: string[] = [];

// ---- web + admin: per-module `modules/<dir>/screens.ts`, wired via `main.tsx` --------------
function scanPerModuleApp(app: string, modulesRoot: string, mainTsxPath: string): void {
  const mainTsx = read(mainTsxPath);
  const moduleDirs = (() => {
    try {
      return readdirSync(join(ROOT, modulesRoot)).filter((d) =>
        existsSync(join(ROOT, modulesRoot, d, "screens.ts")),
      );
    } catch {
      return [];
    }
  })();

  const seenId = new Map<string, string>();
  const seenPath = new Map<string, string>();
  for (const dir of moduleDirs.sort()) {
    const rel = `${modulesRoot}/${dir}/screens.ts`;
    const src = read(rel);
    const moduleId = src.match(/moduleId:\s*(\d+)/)?.[1];
    // A module is "wired" only when the composition root BOTH imports its dir AND calls
    // `registry.register(<itsExport>)`. Checking the import alone was a real hole: a screens.ts
    // that is imported but never registered passes and then 404s at runtime, because the router
    // only knows the screens the registry was handed — exactly how the M30/M39 registrations
    // shipped broken on apps/web.
    const exportName = src.match(/export const (\w+):\s*ScreenRegistryModule/)?.[1];
    const imported = mainTsx.includes(`modules/${dir}`);
    const registered = !!exportName && mainTsx.includes(`registry.register(${exportName})`);
    if (!imported || !registered)
      failures.push(
        `UNREGISTERED SCREENS (${app}): ${rel} exists but is not wired into ${mainTsxPath}`,
      );

    for (const b of parseScreenBlocks(src)) {
      if (seenId.has(b.id))
        failures.push(`DUP SCREEN ID (${app}): "${b.id}" in ${dir} and ${seenId.get(b.id)}`);
      else seenId.set(b.id, dir);
      if (b.path !== "(none)") {
        if (seenPath.has(b.path))
          failures.push(
            `DUP SCREEN PATH (${app}): "${b.path}" in ${dir} and ${seenPath.get(b.path)}`,
          );
        else seenPath.set(b.path, dir);
      }
      if (b.permission !== "(none)" && !catalog.has(b.permission))
        failures.push(
          `UNKNOWN PERMISSION (${app}): screen "${b.id}" (${dir}) requires "${b.permission}", not in the permission catalog`,
        );
      screens.push({ app, module: dir, moduleId: moduleId ? Number(moduleId) : null, ...b });
    }
  }
}

// ---- portal: one flat manifest (metadata) bound to components in registry.ts ---------------
function scanPortal(manifestPath: string, registryPath: string): void {
  const manifestSrc = read(manifestPath);
  const registrySrc = read(registryPath);
  const boundIds = new Set(
    [...registrySrc.matchAll(/^\s*"([^"]+)":\s*\w+,?\s*$/gm)].map((m) => m[1]!),
  );

  const seenId = new Map<string, boolean>();
  const seenPath = new Map<string, string>();
  for (const b of parseScreenBlocks(manifestSrc)) {
    if (seenId.has(b.id))
      failures.push(`DUP SCREEN ID (portal): "${b.id}" appears twice in the manifest`);
    else seenId.set(b.id, true);
    if (b.path !== "(none)") {
      if (seenPath.has(b.path))
        failures.push(
          `DUP SCREEN PATH (portal): "${b.path}" in "${b.id}" and "${seenPath.get(b.path)}"`,
        );
      else seenPath.set(b.path, b.id);
    }
    if (b.permission !== "(none)" && !catalog.has(b.permission))
      failures.push(
        `UNKNOWN PERMISSION (portal): screen "${b.id}" requires "${b.permission}", not in the permission catalog`,
      );
    if (!boundIds.has(b.id))
      failures.push(
        `UNBOUND PORTAL SCREEN: manifest id "${b.id}" has no component binding in ${registryPath}`,
      );
    screens.push({ app: "portal", module: "31-portal", moduleId: 31, ...b });
  }
}

scanPerModuleApp("web", "apps/web/src/modules", "apps/web/src/main.tsx");
scanPerModuleApp("admin", "apps/admin/src/modules", "apps/admin/src/main.tsx");
scanPortal("apps/portal/src/screens/manifest.ts", "apps/portal/src/screens/registry.ts");

// ---- render --------------------------------------------------------------------------------
const byApp = new Map<string, Screen[]>();
for (const s of screens) byApp.set(s.app, [...(byApp.get(s.app) ?? []), s]);
const implementedModules = [...new Set(screens.map((s) => `${s.app}/${s.module}`))].sort();

function renderMarkdown(): string {
  const L: string[] = [];
  L.push("# WardenX — UI Implementation-Parity Report");
  L.push("");
  L.push(
    "> **Generated, advisory report** (`bun run ui:parity`). `docs:ui` proves the screen-spec",
  );
  L.push("> corpus is consistent; this shows how much of it is BUILT across all three SPAs");
  L.push("> (`apps/web`, `apps/portal`, `apps/admin`). Do not hand-edit — the `ui:parity --check`");
  L.push("> gate (in `arch:fitness`) keeps it in sync with source.");
  L.push("");
  L.push(
    `**Coverage:** ${docSpecs.length} documented screen specs · ${implementedModules.length} module screen-sets registered · ${screens.length} screens wired across web/portal/admin.`,
  );
  for (const [app, list] of [...byApp].sort()) L.push(`- **${app}**: ${list.length} screen(s)`);
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
  L.push("| App | Module | Screen id | Route path | Required permission | Permission resolves |");
  L.push("|---|---|---|---|---|:--:|");
  for (const s of screens)
    L.push(
      `| ${s.app} | ${s.module} | \`${s.id}\` | \`${s.path}\` | \`${s.permission}\` | ${s.permission === "(none)" || catalog.has(s.permission) ? "✅" : "❌"} |`,
    );
  L.push("");
  L.push("## Hard-fail consistency checks");
  L.push("");
  L.push(
    failures.length
      ? failures.map((f) => `- ❌ ${f}`).join("\n")
      : "- ✅ No duplicate screen ids/paths (per app), all `requiredPermission`s resolve, all module screen-sets are registered.",
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
    `OK ui-parity: report fresh (${docSpecs.length} documented · ${screens.length} screens registered across ${byApp.size} app(s))`,
  );
  process.exit(0);
}

mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
writeFileSync(join(ROOT, OUT_MD), md);
writeFileSync(join(ROOT, OUT_JSON), jsonOut);
console.log(
  `✓ ui-parity → ${OUT_MD} (${docSpecs.length} documented · ${screens.length} screens registered across ${byApp.size} app(s))`,
);
