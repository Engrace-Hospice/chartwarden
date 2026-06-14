import { defineConfig } from "vitest/config";

/**
 * WardenX — Vitest config (Phase 0).
 * Test runner ratified in PHASE_0_SCAFFOLD_PLAN.md §2 D-e.
 * Phase 0 tests live under scripts/__tests__/ (fitness-gate self-tests that prove
 * each gate goes RED on a planted violation and GREEN on the baseline). Feature
 * modules add *.test.ts beside their source as they land in Phase 1+.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/__tests__/**/*.test.ts", "apps/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "scripts/__fixtures__/**"],
    testTimeout: 30_000,
  },
});
