// e2e/specs/admin-console-smoke.spec.ts — #852: platform-ops console (apps/admin, Vite :5175).
//
// Run by the `admin-console` project only, and only when `E2E_ADMIN_URL` names a running console.
// The local seed mints orgadmin@ with platform_ops, so this
// project covers both the pre-auth surface and every static authenticated console screen.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { DEMO_ORG_NAME, PLATFORM_OPS_ACCOUNT } from "../fixtures/credentials";
import { axeViolationSummaries, expectRouteReached } from "../fixtures/helpers";

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

async function signInToAdminConsole(page: Page): Promise<void> {
  const account = PLATFORM_OPS_ACCOUNT();
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(account.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/login/organization");
  await page.getByRole("button", { name: `Select ${DEMO_ORG_NAME}` }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });
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
      expect(await axeViolationSummaries(page)).toEqual([]);
    });
  }

  test("a platform-ops session walks every static authenticated console screen", async ({
    page,
  }) => {
    const routes = authenticatedAdminRoutes();
    expect(routes.length).toBeGreaterThan(20);
    test.setTimeout(Math.max(120_000, routes.length * 8_000));
    await signInToAdminConsole(page);

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
      failures.push(
        ...(await axeViolationSummaries(page)).map((violation) => `${route}: ${violation}`),
      );
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
