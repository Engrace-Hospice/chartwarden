/**
 * WardenX — Scaffold generator (single source of truth: module-manifest.ts)
 * -------------------------------------------------------------------------
 * Emits the buildable monorepo skeleton DERIVED FROM the manifest so the tree maps
 * 1:1 to `codePaths`. Per PHASE_0_SCAFFOLD_PLAN.md §3 this guarantees the
 * dependency-cruiser boundary graph is real (every owned path is a real, scannable
 * directory) rather than documentation.
 *
 * What it creates (idempotent — never overwrites hand-authored content):
 *   - packages/<name>/{package.json, tsconfig.json, src/index.ts}  for every package
 *     root in a codePath + the leaves (domain, ui) not in any codePath.
 *   - apps/<name>/{package.json, tsconfig.json, src/index.ts}      for every app root.
 *   - a placeholder index.ts in every sub-path codePath (e.g. packages/auth/src/rbac,
 *     apps/backend/src/modules/NN-slug) so per-module boundary scans have real files.
 *   - the root solution tsconfig.json with `references` to every package + app.
 *
 * Modes:
 *   (default)   write/create missing scaffolding; leave existing files untouched.
 *   --check     verify tree↔manifest parity; exit 1 on drift (the `arch:parity` gate).
 *               Creates nothing.
 *
 * Run:   bun run scripts/scaffold-from-manifest.ts [--check]
 *        bun run scaffold        (alias)   ·   bun run arch:parity  (--check)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ALL_OWNED_PATHS, LEAF_PACKAGES, MODULES } from "../architecture/module-manifest";

const ROOT = process.cwd();
const CHECK = process.argv.includes("--check");

// Hand-authored paths the generator must NOT stub over with a bare `export {}` —
// these get their real content in later Phase-0 work packages (PR-0.3 / PR-0.4).
const HAND_AUTHORED_DIRS = new Set<string>([
  "packages/db/src/schema",
  "apps/backend/src/bootstrap",
]);

const drift: string[] = [];
const created: string[] = [];

function rootOf(codePath: string): string {
  const [top, second] = codePath.split("/");
  if (top === "packages" || top === "apps") return `${top}/${second}`;
  return codePath;
}

// ---- derive the authoritative set from the manifest ----
const codePaths = [...new Set(ALL_OWNED_PATHS)].sort();
const packageRoots = new Set<string>();
const appRoots = new Set<string>();
for (const cp of codePaths) {
  const r = rootOf(cp);
  if (r.startsWith("packages/")) packageRoots.add(r);
  else if (r.startsWith("apps/")) appRoots.add(r);
}
// Leaves declared in LEAF_PACKAGES that appear in no codePath (domain, ui).
for (const leaf of LEAF_PACKAGES) packageRoots.add(leaf);

const allRoots = [...packageRoots, ...appRoots].sort();

// ---- helpers ----
function ensureDir(rel: string): void {
  const abs = join(ROOT, rel);
  if (existsSync(abs)) return;
  if (CHECK) {
    drift.push(`missing directory: ${rel}`);
    return;
  }
  mkdirSync(abs, { recursive: true });
  created.push(`dir  ${rel}`);
}

function ensureFile(rel: string, content: string): void {
  const abs = join(ROOT, rel);
  if (existsSync(abs)) return;
  if (CHECK) {
    drift.push(`missing file: ${rel}`);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  created.push(`file ${rel}`);
}

function nameFor(root: string): string {
  return `@chartwarden/${root.split("/")[1]}`;
}

function relBase(root: string): string {
  return relative(join(ROOT, root), ROOT).replaceAll("\\", "/");
}

function pkgJson(root: string): string {
  return `${JSON.stringify(
    {
      name: nameFor(root),
      version: "0.0.0",
      private: true,
      type: "module",
      exports: { ".": "./src/index.ts" },
      types: "./src/index.ts",
    },
    null,
    2,
  )}\n`;
}

function tsconfigJson(root: string): string {
  return `${JSON.stringify(
    {
      extends: `${relBase(root)}/tsconfig.base.json`,
      compilerOptions: { rootDir: "src", outDir: "dist" },
      include: ["src"],
    },
    null,
    2,
  )}\n`;
}

function indexStub(root: string): string {
  return `// ${nameFor(root)} — Phase 0 placeholder (no business logic; see PHASE_0_SCAFFOLD_PLAN.md).\nexport {};\n`;
}

function subPathStub(codePath: string): string {
  return `// ${codePath} — Phase 0 placeholder owned per module-manifest.ts. No business logic yet.\nexport {};\n`;
}

// ---- 1. package/app roots ----
for (const root of allRoots) {
  ensureDir(root);
  ensureFile(`${root}/package.json`, pkgJson(root));
  ensureFile(`${root}/tsconfig.json`, tsconfigJson(root));
  ensureFile(`${root}/src/index.ts`, indexStub(root));
}

// ---- 2. every codePath dir gets a real, scannable placeholder file ----
for (const cp of codePaths) {
  // package/app roots already have src/index.ts; sub-path codePaths get their own.
  const root = rootOf(cp);
  if (cp === root) continue;
  ensureDir(cp);
  if (HAND_AUTHORED_DIRS.has(cp)) {
    // Real content lands in PR-0.3 / PR-0.4; just guarantee the dir exists.
    if (!existsSync(join(ROOT, cp)) && !CHECK) {
      mkdirSync(join(ROOT, cp), { recursive: true });
    }
    continue;
  }
  ensureFile(`${cp}/index.ts`, subPathStub(cp));
}

// ---- 3. root solution tsconfig.json (references every package + app, plus scripts/) ----
// `scripts/` is NOT manifest-driven — it is not a module, owns no tables, and is not scaffolded —
// but it must be in the project graph or `tsc -b` silently skips ~24.7k lines that decide whether
// the architecture gates pass (#34). It is appended here rather than hand-added to the root
// tsconfig, because this generator rewrites that file wholesale and would drop it on the next
// `bun run scaffold`.
const NON_MANIFEST_PROJECTS = ["scripts"] as const;
const refs = [...allRoots, ...NON_MANIFEST_PROJECTS].map((r) => ({ path: `./${r}` }));
const rootTsconfig = `${JSON.stringify(
  {
    files: [],
    extends: "./tsconfig.base.json",
    compilerOptions: { composite: false },
    references: refs,
  },
  null,
  2,
)}\n`;
{
  const rel = "tsconfig.json";
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    if (CHECK) drift.push(`missing file: ${rel}`);
    else {
      writeFileSync(abs, rootTsconfig);
      created.push(`file ${rel}`);
    }
  } else {
    const current = readFileSync(abs, "utf8");
    if (current !== rootTsconfig) {
      if (CHECK) drift.push("stale root tsconfig.json references (re-run `bun run scaffold`)");
      else {
        writeFileSync(abs, rootTsconfig);
        created.push(`file ${rel} (updated references)`);
      }
    }
  }
}

// ---- 4. orphan detection (--check): a packages/* or apps/* dir not in the manifest ----
if (CHECK) {
  for (const top of ["packages", "apps"]) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(ROOT, top));
    } catch {
      continue;
    }
    for (const e of entries) {
      const r = `${top}/${e}`;
      if (e.startsWith(".")) continue;
      if (!allRoots.includes(r)) drift.push(`orphan: ${r} exists but is in no manifest codePath`);
    }
  }
}

// ---- report ----
if (CHECK) {
  if (drift.length === 0) {
    console.log(
      `✓ scaffold-parity: ${packageRoots.size} packages + ${appRoots.size} apps map 1:1 to manifest codePaths`,
    );
    process.exit(0);
  }
  console.error(`✗ scaffold-parity: ${drift.length} drift item(s) — run \`bun run scaffold\`\n`);
  for (const d of drift) console.error(`  ${d}`);
  process.exit(1);
}

if (created.length === 0) {
  console.log("✓ scaffold: tree already matches manifest (nothing to create)");
} else {
  console.log(`✓ scaffold: created ${created.length} item(s)`);
  for (const c of created) console.log(`  + ${c}`);
}
