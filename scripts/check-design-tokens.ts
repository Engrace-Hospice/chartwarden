/**
 * WardenX — Design-token enforcement  (Lantern; fitness check)
 * ------------------------------------------------------------------
 * Locks in the "tokens only, zero raw hex" discipline the R0/R1 Lantern reconciliation
 * established (DESIGN.md §2/§10/§11) so it survives future PRs instead of relying on reviewer
 * vigilance. Two rules:
 *
 *   1. NO RAW COLOR IN RENDER CODE — `.ts`/`.tsx` under `apps/web/src` and `packages/ui/src/web`
 *      may not contain a raw hex (`#rgb`/`#rrggbb`/`#rrggbbaa`) or `rgb(`/`rgba(` literal. Color
 *      must flow through the CSS-var tokens (`var(--color-*)` / the `t` map) so it stays
 *      theme-reactive (light ⇄ twilight dark) by construction. The token DEFINITION files are
 *      exempt (they are where the raw values legitimately live).
 *
 *   2. COLOR SOURCE-OF-TRUTH SYNC — every brand hex in `packages/ui/src/core/theme/colors.ts`
 *      (the Tailwind-config seed) must also appear in the canonical `@theme` light block of
 *      `apps/web/src/index.css` (the runtime tokens). Catches the dual-source drift between the
 *      two color tables.
 *
 * Heuristic, static, import-level (same posture as check-tenancy.ts / check-ddl-legality.ts).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Render trees the rule covers.
const SCAN_DIRS = ["apps/web/src", "packages/ui/src/web"];

// Token-definition files where raw color values legitimately live (exempt from rule 1).
const ALLOW = new Set([
  "packages/ui/src/web/theme/tokens.ts",
  "packages/ui/src/web/theme/tailwind.config.ts",
]);

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const RGB = /\brgba?\(/;

/** Strip // line comments and /* *\/ block comments so commentary never trips the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string): string[] {
  const abs = join(REPO_ROOT, dir);
  let entries: string[];
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = `${dir}/${e}`;
    const full = join(REPO_ROOT, rel);
    if (statSync(full).isDirectory()) {
      if (e === "dist" || e === "node_modules") continue;
      out.push(...walk(rel));
    } else if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) {
      out.push(rel);
    }
  }
  return out;
}

type Violation = { rule: string; file: string; detail: string };
const violations: Violation[] = [];

// ── Rule 1 — no raw color in render code ──────────────────────────────────────────────────────────
for (const dir of SCAN_DIRS) {
  for (const rel of walk(dir)) {
    if (ALLOW.has(rel)) continue;
    const lines = stripComments(readFileSync(join(REPO_ROOT, rel), "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (HEX.test(line) || RGB.test(line)) {
        violations.push({
          rule: "raw-color-in-render",
          file: rel,
          detail: `line ${i + 1}: raw hex/rgb literal — use a Lantern token (var(--color-*) or the \`t\` map) so it stays theme-reactive\n      ${line.trim().slice(0, 100)}`,
        });
      }
    });
  }
}

// ── Rule 2 — colors.ts brand hex must exist in the index.css @theme light block ────────────────────
const cssPath = "apps/web/src/index.css";
const colorsPath = "packages/ui/src/core/theme/colors.ts";
const css = readFileSync(join(REPO_ROOT, cssPath), "utf8");
const themeBlock = css.slice(css.indexOf("@theme"), css.indexOf("}", css.indexOf("@theme")));
const colorsSrc = readFileSync(join(REPO_ROOT, colorsPath), "utf8");
// brandColors hex values (skip the statusColors triad — those are not part of @theme by design).
const brandSeg = colorsSrc.slice(colorsSrc.indexOf("brandColors"));
for (const m of brandSeg.matchAll(/"(#[0-9a-fA-F]{3,8})"/g)) {
  const hex = m[1]!;
  if (!themeBlock.toLowerCase().includes(hex.toLowerCase())) {
    violations.push({
      rule: "color-source-drift",
      file: colorsPath,
      detail: `brand hex ${hex} is not present in the canonical @theme light block of ${cssPath} — the two color sources have drifted`,
    });
  }
}

if (violations.length === 0) {
  console.log(
    "✓ design-tokens: no raw hex/rgb in render code; colors.ts ↔ index.css @theme in sync",
  );
  process.exit(0);
}
console.error(`✗ design-tokens: ${violations.length} violation(s)\n`);
for (const v of violations)
  console.error(`  [${v.rule}] ${relative(REPO_ROOT, join(REPO_ROOT, v.file))}\n    ${v.detail}\n`);
process.exit(1);
