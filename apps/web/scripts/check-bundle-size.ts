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
 * The budget (BUDGET_BYTES below; originally TASK-033's 350 kB) is the acceptance criterion (raw, uncompressed bytes — the audit's own
 * `ls -la` methodology, report 12). This is a standalone opt-in check, not wired into `arch:fitness`.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type BundleMeasurement,
  measureInitialBundle,
} from "../../../scripts/lib/bundle-size-gate";

const CHECK = process.argv.includes("--check");
// Budget history (#849): the 350 kB TASK-033 target was missed by 200 kB once every module web-slice registered.
// Lazy RoleHome/ScreenLock/auth client + `@chartwarden/types` `sideEffects:false` (drops the eager TypeBox schemas)
// took the entry from 555.4 kB to 420.8 kB. What remains is not route code: react-dom ~128 kB + react-router ~91 kB +
// react ~7 kB (the ~226 kB floor), ~100 kB of nav/permission metadata from the ~40 `modules/*/screens.ts` the
// router needs up front to build every route, and ~70 kB of shell/@chartwarden/ui chrome. Budget = measured + ~2%
// headroom. Ratchet: when a change lowers the entry, lower this number in the same PR; never raise it without
// re-profiling (a rollup `sourcemap` + mapping-size breakdown) and naming what grew.
const BUDGET_BYTES = 430 * 1024;
const BASE = ""; // Vite base "/" — built URLs are "/assets/..."
const DIST_DIR = join(process.cwd(), "dist/app");
const INDEX_HTML = join(DIST_DIR, "index.html");

if (!existsSync(INDEX_HTML)) {
  console.error(`Not found: ${INDEX_HTML} — run \`bun run build:app\` first.`);
  process.exit(1);
}

// Every eagerly-fetched asset the entry HTML references (entry script + modulepreload links).
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
