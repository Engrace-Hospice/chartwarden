// e2e/specs/admin-console-smoke.spec.ts — #852: platform-ops console (apps/admin, Vite :5175).
//
// Run by the `admin-console` project only, and only when `E2E_ADMIN_URL` names a running console — the
// CI e2e job starts the web app alone. Scope is deliberately the PRE-AUTH surface: a signed-out visit
// to a gated route lands on the console's own sign-in, and the chrome-less static screens scan clean.
// A signed-in walk of the 39 registered admin screens needs a platform_ops account the demo seed does
// not mint for the console login (see docs/testing/manual-a11y-protocol.md "Not automated").
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.skip(
  !process.env.E2E_ADMIN_URL,
  "E2E_ADMIN_URL is unset: start apps/admin (`cd apps/admin && bun run dev`, :5175) and export E2E_ADMIN_URL=http://localhost:5175",
);

const PUBLIC_ADMIN_ROUTES = ["/login", "/403", "/error"] as const;

test.describe("Admin console — smoke (#852)", () => {
  test("a signed-out visit to a gated route is sent to the console sign-in", async ({ page }) => {
    await page.goto("/tenants");
    await expect.poll(() => new URL(page.url()).pathname).toContain("/login");
  });

  for (const route of PUBLIC_ADMIN_ROUTES) {
    test(`${route} renders and scans clean for WCAG 2A/AA`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#root > *").first()).toBeVisible();
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
      ).toEqual([]);
    });
  }
});
