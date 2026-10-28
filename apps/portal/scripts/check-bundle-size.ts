/**
 * apps/portal — initial-bundle-size check (WX-PR-022, PERF-001).
 *
 * Mirrors apps/web/scripts/check-bundle-size.ts (TASK-033) — that script existed for web only;
 * PERF-001 flagged portal/admin as having no budget at all, and (unlike web) neither app has
 * route-level `React.lazy` splitting yet, so its whole entry bundle IS the initial payload. Reads
 * the built `dist/app/index.html` and sums every eagerly-fetched `<script>`/`<link modulepreload>`
 * asset — correct for a single-chunk build today, and automatically correct if/when this app
 * gains lazy-loaded routes (only the entry's static import graph would count).
 *
 * Usage:
 *   bun run build:app && bun run size:check            → report the current initial payload
 *   bun run build:app && bun run size:check --check    → same, but exit 1 over budget
 *
 * 350 kB (raw, uncompressed) matches web's TASK-033 budget — portal's current entry is ~290 kB, so
 * this has real headroom, not a rubber-stamped pass. Standalone opt-in check, not wired into
 * `arch:fitness` (a full `vite build` per app is too slow for the fast gate).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type BundleMeasurement,
  measureInitialBundle,
} from "../../../scripts/lib/bundle-size-gate";
import { resolvePortalBase } from "../src/base-path";

const CHECK = process.argv.includes("--check");
const BUDGET_BYTES = 350 * 1024;
// Vite base without trailing slash (#848): built HTML URLs carry it ("/portal/assets/..."), outDir paths do not.
const BASE = resolvePortalBase(process.env.VITE_PORTAL_BASE);
const DIST_DIR = join(process.cwd(), "dist/app");
const INDEX_HTML = join(DIST_DIR, "index.html");

if (!existsSync(INDEX_HTML)) {
  console.error(`Not found: ${INDEX_HTML} — run \`bun run build:app\` first.`);
  process.exit(1);
}

// Fails closed (#848): a missing/external asset or an empty/zero-byte measurement is an error, never a pass.
let measured: BundleMeasurement;
try {
  measured = measureInitialBundle(DIST_DIR, BASE);
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
const { rows, total } = measured;

console.log(`Initial bundle (${rows.length} eagerly-fetched file(s) from ${dirname(INDEX_HTML)}):`);
for (const r of rows) {
  console.log(`  ${(r.bytes / 1024).toFixed(1).padStart(8)} kB  ${r.path}`);
}
console.log(`  ${"-".repeat(30)}`);
console.log(
  `  ${(total / 1024).toFixed(1).padStart(8)} kB  total (budget ${BUDGET_BYTES / 1024} kB)`,
);

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
