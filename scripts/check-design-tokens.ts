/**
 * ChartWarden — Design-token enforcement  (Lantern; fitness check)
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
 *   3. APP TOKEN PARITY — the local runtime token layers in apps/admin and apps/portal must match
 *      apps/web for the shared light/dark contract. The repository deliberately keeps these local
 *      (Tailwind v4 emission + app boundaries), so this rule makes the copies mechanically safe.
 *
 * Heuristic, static, import-level (same posture as check-tenancy.ts / check-ddl-legality.ts).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Rooted off the script's own file location (not process.cwd()) so it always validates the real
// repo regardless of the caller's working directory. `CHARTWARDEN_FITNESS_ROOT` is a test-only escape
// hatch (scripts/__tests__/fitness-gates.test.ts) letting the planted-violation fixture point this
// gate at an isolated tree instead of the real one — unset in every real invocation.
const REPO_ROOT =
  process.env.CHARTWARDEN_FITNESS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");

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

// ── Rule 3 — web/admin/portal local CSS token layers stay equal ──────────────────────────────────
const TOKEN_APPS = ["apps/admin/src/index.css", "apps/portal/src/index.css"] as const;
const CONTRACT_PREFIXES = ["color-", "font-", "radius-", "shadow-", "space-"] as const;

function normalizedValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function declarations(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
    const key = match[1]!;
    if (CONTRACT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      out.set(key, normalizedValue(match[2]!));
    }
  }
  return out;
}

function themeParts(source: string): { light: Map<string, string>; dark: Map<string, string> } {
  const firstDark = source.search(/\.dark\s*\{/);
  const light = declarations(firstDark === -1 ? source : source.slice(0, firstDark));
  const dark = new Map<string, string>();
  for (const match of source.matchAll(/\.dark\s*\{([^}]]*)\}/g)) {
    for (const [key, value] of declarations(match[1]!)) dark.set(key, value);
  }
  return { light, dark };
}

const canonical = themeParts(css);
for (const appPath of TOKEN_APPS) {
  // Planted-violation fixtures intentionally contain only the minimum files needed by rules 1–2.
  // App parity applies to the real repository (and to any fixture that supplies an app layer).
  if (!existsSync(join(REPO_ROOT, appPath))) continue;
  const candidate = themeParts(readFileSync(join(REPO_ROOT, appPath), "utf8"));
  for (const mode of ["light", "dark"] as const) {
    for (const [key, expected] of canonical[mode]) {
      const actual = candidate[mode].get(key);
      if (actual !== expected) {
        violations.push({
          rule: "app-token-drift",
          file: appPath,
          detail: `${mode} --${key} is ${actual ?? "missing"}; expected ${expected} from ${cssPath}`,
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(
    "✓ design-tokens: render colors clean; core ↔ web source synced; app token layers match",
  );
  process.exit(0);
}
console.error(`✗ design-tokens: ${violations.length} violation(s)\n`);
for (const v of violations)
  console.error(`  [${v.rule}] ${relative(REPO_ROOT, join(REPO_ROOT, v.file))}\n    ${v.detail}\n`);
process.exit(1);
