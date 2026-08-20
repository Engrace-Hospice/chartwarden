import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * WardenX — Vitest config (Phase 0).
 * Test runner ratified in PHASE_0_SCAFFOLD_PLAN.md §2 D-e.
 * Phase 0 tests live under scripts/__tests__/ (fitness-gate self-tests that prove
 * each gate goes RED on a planted violation and GREEN on the baseline). Feature
 * modules add *.test.ts beside their source as they land in Phase 1+.
 *
 * TASK-050C (TEST-004): `*.dom.test.tsx` files run under jsdom instead of the default node
 * environment — the one carve-out for component-rendering tests (registry-driven screen smoke
 * renders for web/portal/admin). Everything else (route inject suites, pure-logic unit tests)
 * stays on "node", which is faster and was already proven sufficient for ~7500 existing tests.
 * `@vitejs/plugin-react` is only needed to transform the JSX those dom tests (and the screen
 * components they render) contain — a no-op for every plain .ts test file.
 *
 * WX-PR-021 (TEST-003): `environmentMatchGlobs` is deprecated (every run warned); this is the
 * `test.projects` replacement Vitest's own deprecation message points at — two projects sharing
 * the include/exclude base, split only on which glob (dom vs. everything else) and its environment.
 */
const EXCLUDE = ["**/node_modules/**", "**/dist/**", "scripts/__fixtures__/**"];
// GAP-080: `packages/**` was outside the dom project, so a hook or component that lives in
// @wardenx/ui — where the shared UI surface actually lives — had no jsdom project to run in at all.
// Both globs are listed rather than one `**/*.dom.test.tsx` so the exclude below stays a literal
// mirror of the include (the node project subtracts exactly these).
const DOM_GLOBS = ["apps/**/*.dom.test.tsx", "packages/**/*.dom.test.tsx"];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        test: {
          name: "node",
          environment: "node",
          include: [
            "scripts/__tests__/**/*.test.ts",
            "apps/**/*.test.ts",
            "apps/**/*.test.tsx",
            "packages/**/*.test.ts",
          ],
          exclude: [...EXCLUDE, ...DOM_GLOBS],
          testTimeout: 50_000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: "dom",
          environment: "jsdom",
          setupFiles: ["./vitest.setup.dom.ts"],
          include: DOM_GLOBS,
          exclude: EXCLUDE,
          testTimeout: 50_000,
        },
      },
    ],
  },
});
