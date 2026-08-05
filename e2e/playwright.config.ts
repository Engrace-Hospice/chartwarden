// e2e/playwright.config.ts — WX-PR-018 critical-workflow E2E suite (TEST-001).
//
// Deliberately does NOT start its own webServer: the target is the full local stack (Postgres +
// Valkey + Fastify backend + Vite web), which this repo already documents how to bring up
// (docs/DEVELOPMENT.md / `bun run db:reset && bun run dev`) — reimplementing that orchestration
// here would duplicate it and drift. Run `bun run test:e2e` against an already-running stack, same
// expectation as the `*.live.test.ts` vitest suites (rls-isolation, m6-write, etc.) have for a live
// Postgres — except this suite is NOT part of the default `bun run test` (it needs a live browser +
// full stack, not just a DB), so it stays out of the fast/hermetic default gate.
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

export default defineConfig({
  testDir: "./specs",
  outputDir: "./test-results",
  globalSetup: "./global-setup.ts",
  // Serial, not parallel: every spec signs in, and every Playwright worker on one machine shares one
  // client ip. SD-055's unauthenticated tier (security.ts) is keyed per-ip and doesn't distinguish
  // request PURPOSE from auth state — the sign-in call itself is inherently pre-auth, so it has
  // nowhere to bucket except `ip:`. Running these specs with real concurrency multiplies that load
  // and self-DoSes the suite against its own rate limiter rather than testing anything real. Serial
  // execution keeps the load realistic; RATE_LIMIT_UNAUTHENTICATED_PER_MINUTE (.env.example) is the
  // other half — raising the LOCAL tier rather than loosening the shipped production default.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]]
    : "list",
  timeout: 30_000,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
