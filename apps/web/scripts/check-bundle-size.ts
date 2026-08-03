/**
 * apps/web — initial-bundle-size check (TASK-033).
 *
 * Route-level `React.lazy` (screens.ts, TASK-033) means most screen code no longer ships in the
 * first request — but nothing measured that until now (report 12 only ever spot-checked with
 * `ls -la dist/app/assets`). This script reads the built `dist/app/index.html` and sums the bytes
 * of exactly what a fresh page load fetches eagerly: the entry `<script type="module">` plus every
 * `<link rel="modulepreload">` Vite emits for its static import graph. Route chunks reachable only
 * through a lazy() call are NOT in that graph, so they're correctly excluded.
 *
 * Usage:
 *   bun run build:app && bun run size:check            → report the current initial payload
 *   bun run build:app && bun run size:check --check    → same, but exit 1 over budget
 *
 * The 350 kB budget is TASK-033's acceptance criterion (raw, uncompressed bytes — the audit's own
 * `ls -la` methodology, report 12). This is a standalone opt-in check, not wired into `arch:fitness`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const CHECK = process.argv.includes("--check");
const BUDGET_BYTES = 350 * 1024;
const DIST_DIR = join(process.cwd(), "dist/app");
const INDEX_HTML = join(DIST_DIR, "index.html");

if (!existsSync(INDEX_HTML)) {
  console.error(`Not found: ${INDEX_HTML} — run \`bun run build:app\` first.`);
  process.exit(1);
}

const html = readFileSync(INDEX_HTML, "utf8");

// Every eagerly-fetched asset the entry HTML references: the module entry script plus each
// modulepreload link Vite emits for the entry's static import graph (its vendor/shared chunks).
const assetPaths = new Set<string>();
for (const m of html.matchAll(/<(?:script[^>]*\ssrc|link[^>]*\shref)="([^"]+\.js)"/g)) {
  assetPaths.add(m[1]);
}

if (assetPaths.size === 0) {
  console.error("No <script>/<link modulepreload> assets found in index.html — nothing to measure.");
  process.exit(1);
}

let total = 0;
const rows: { path: string; bytes: number }[] = [];
for (const assetPath of assetPaths) {
  const abs = join(DIST_DIR, assetPath.replace(/^\//, ""));
  if (!existsSync(abs)) continue;
  const bytes = statSync(abs).size;
  total += bytes;
  rows.push({ path: assetPath, bytes });
}
rows.sort((a, b) => b.bytes - a.bytes);

console.log(`Initial bundle (${rows.length} eagerly-fetched file(s) from ${dirname(INDEX_HTML)}):`);
for (const r of rows) {
  console.log(`  ${(r.bytes / 1024).toFixed(1).padStart(8)} kB  ${r.path}`);
}
console.log(`  ${"-".repeat(30)}`);
console.log(`  ${(total / 1024).toFixed(1).padStart(8)} kB  total (budget ${BUDGET_BYTES / 1024} kB)`);

if (total > BUDGET_BYTES) {
  const msg = `Initial bundle is ${(total / 1024).toFixed(1)} kB, over the ${BUDGET_BYTES / 1024} kB budget.`;
  if (CHECK) {
    console.error(`\nFAIL: ${msg}`);
    process.exit(1);
  }
  console.warn(`\nWARN: ${msg}`);
} else {
  console.log(`\nOK: within the ${BUDGET_BYTES / 1024} kB budget.`);
}
