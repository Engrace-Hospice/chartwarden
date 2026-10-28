// e2e/playwright.config.ts — WX-PR-018 critical-workflow E2E suite (TEST-001).
//
// Deliberately does NOT start its own webServer: the target is the full local stack (Postgres +
// Valkey + Fastify backend + Vite web), which this repo already documents how to bring up
// (docs/START_PROJECT.md / `bun run db:reset && bun run dev`) — reimplementing that orchestration
// here would duplicate it and drift. Run `bun run test:e2e` against an already-running stack, same
// expectation as the `*.live.test.ts` vitest suites (rls-isolation, m6-write, etc.) have for a live
// Postgres — except this suite is NOT part of the default `bun run test` (it needs a live browser +
// full stack, not just a DB), so it stays out of the fast/hermetic default gate.
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

// #852 — specs owned by dedicated projects; the default `chromium` project must not run them.
const VIEWPORT_SPEC = /viewport-matrix\.spec\.ts$/;
const ADMIN_SPEC = /admin-console-smoke\.spec\.ts$/;
const PORTAL_SPEC = /portal-smoke\.spec\.ts$/;
const SPECIAL_SPECS = [VIEWPORT_SPEC, ADMIN_SPEC, PORTAL_SPEC];

/** The six required viewports (320 = WCAG 1.4.10 reflow floor; 768/1024 = tablet portrait/landscape). */
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

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
  projects: [
    // The default job: every spec EXCEPT the opt-in ones below. `test:e2e` runs this project only.
    {
      name: "chromium",
      testIgnore: SPECIAL_SPECS,
      use: { ...devices["Desktop Chrome"] },
    },
    // #852 — the six required viewports. One small layout smoke each (not every spec x 6), so the
    // matrix is six short runs of one file. `bun run test:e2e:viewports`.
    ...VIEWPORTS.map(({ width, height }) => ({
      name: `viewport-${width}`,
      testMatch: VIEWPORT_SPEC,
      use: { ...devices["Desktop Chrome"], viewport: { width, height } },
    })),
    // #852 — the other two SPAs. Each has its own dev server, which the CI e2e job does not start, so
    // the specs skip (with the reason in their output) until E2E_ADMIN_URL / E2E_PORTAL_URL is set.
    {
      name: "admin-console",
      testMatch: ADMIN_SPEC,
      use: { ...devices["Desktop Chrome"], baseURL: process.env.E2E_ADMIN_URL },
    },
    {
      name: "portal",
      testMatch: PORTAL_SPEC,
      use: { ...devices["Desktop Chrome"], baseURL: process.env.E2E_PORTAL_URL },
    },
  ],
});
