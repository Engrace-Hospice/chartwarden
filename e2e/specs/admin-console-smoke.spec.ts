// e2e/specs/admin-console-smoke.spec.ts — #852: platform-ops console (apps/admin, Vite :5175).
//
// Run by the `admin-console` project only, and only when `E2E_ADMIN_URL` names a running console.
// The local seed mints orgadmin@ with platform_ops, so this
// project covers both the pre-auth surface and every static authenticated console screen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { PLATFORM_OPS_ACCOUNT } from "../fixtures/credentials";
import { expectRouteReached, signInAs } from "../fixtures/helpers";

test.skip(
  !process.env.E2E_ADMIN_URL,
  "E2E_ADMIN_URL is unset: start apps/admin (`cd apps/admin && bun run dev`, :5175) and export E2E_ADMIN_URL=http://localhost:5175",
);

const PUBLIC_ADMIN_ROUTES = ["/login", "/403", "/error"] as const;

interface RegisteredScreen {
  readonly app: string;
  readonly path: string;
  readonly permission: string;
}

function authenticatedAdminRoutes(): string[] {
  const parity = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", "audit", "ui-parity", "ui-parity.json"),
      "utf8",
    ),
  ) as { screens: RegisteredScreen[] };
  return parity.screens
    .filter((screen) => screen.app === "admin")
    .filter((screen) => screen.permission !== "(none)" && !screen.path.includes(":"))
    .map((screen) => screen.path)
    .sort();
}

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
      await expectRouteReached(page, route, { allowFallbackScreen: true });
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
      ).toEqual([]);
    });
  }

  test("a platform-ops session walks every static authenticated console screen", async ({
    page,
  }) => {
    const routes = authenticatedAdminRoutes();
    expect(routes.length).toBeGreaterThan(20);
    test.setTimeout(Math.max(120_000, routes.length * 8_000));
    await signInAs(page, PLATFORM_OPS_ACCOUNT());

    const failures: string[] = [];
    for (const route of routes) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      try {
        await expectRouteReached(page, route);
      } catch (error) {
        failures.push(`${route}: ${String(error)}`);
        continue;
      }
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      for (const violation of results.violations) {
        failures.push(
          `${route}: ${violation.id} — ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
        );
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
