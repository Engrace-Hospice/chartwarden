// e2e/specs/portal-smoke.spec.ts — #852: Patient/Family Portal PWA (apps/portal, Vite :5174, base /portal/).
//
// Run by the `portal` project only, and only when `E2E_PORTAL_URL` names a running portal.
// db:seed:portal creates a synthetic password-capable patient-self
// account, so this project covers authenticated screens without requiring a mail sink.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { PORTAL_ACCOUNT } from "../fixtures/credentials";
import { expectRouteReached } from "../fixtures/helpers";

test.skip(
  !process.env.E2E_PORTAL_URL,
  "E2E_PORTAL_URL is unset: start apps/portal (`cd apps/portal && bun run dev`, :5174) and export E2E_PORTAL_URL=http://localhost:5174",
);

// Registered `portal` screens with permission "(none)" (audit/ui-parity/ui-parity.json), under the /portal base.
const PUBLIC_PORTAL_ROUTES = [
  "/portal/",
  "/portal/accept-invitation",
  "/portal/funeral/redeem",
  "/portal/collaborator/redeem",
] as const;

interface RegisteredScreen {
  readonly app: string;
  readonly path: string;
  readonly permission: string;
}

const PATIENT_PORTAL_PATH = /^\/p\/:patientId(?:\/[a-z-]+)*$/;

function authenticatedPortalRoutes(patientId: string): string[] {
  const parity = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", "audit", "ui-parity", "ui-parity.json"),
      "utf8",
    ),
  ) as { screens: RegisteredScreen[] };
  return parity.screens
    .filter((screen) => screen.app === "portal" && screen.permission !== "(none)")
    .filter((screen) => !screen.path.includes(":") || PATIENT_PORTAL_PATH.test(screen.path))
    .map((screen) => `/portal${screen.path.replace(":patientId", patientId)}`)
    .sort();
}

test.describe("Portal — pre-auth smoke (#852)", () => {
  for (const route of PUBLIC_PORTAL_ROUTES) {
    test(`${route} renders and scans clean for WCAG 2A/AA`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#root > *").first()).toBeVisible();
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      await expectRouteReached(page, route);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
      ).toEqual([]);
    });
  }

  test("the seeded patient-self account reaches authenticated portal screens", async ({ page }) => {
    const routeCount = authenticatedPortalRoutes("pending-patient-id").length;
    test.setTimeout(Math.max(120_000, routeCount * 8_000));
    const account = PORTAL_ACCOUNT();
    await page.goto("/portal/");
    await page.getByRole("button", { name: "Use a password instead" }).click();
    await page.getByLabel("Email address").fill(account.email);
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // `/signed-in` establishes the portal account, then the single-patient picker auto-opens the
    // only granted record. Navigating away from that transient route aborts establishment.
    await page.waitForURL(/\/portal\/p\/[^/]+$/, { timeout: 30_000 });
    const patientId = new URL(page.url()).pathname.match(/\/portal\/p\/([^/]+)/)?.[1];
    if (!patientId) throw new Error(`could not discover portal patient id from ${page.url()}`);

    const routes = authenticatedPortalRoutes(patientId);
    expect(routes.length).toBeGreaterThan(10);
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
